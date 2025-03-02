import * as vscode from 'vscode';
import { execSync } from 'child_process';
import process from 'process';
import * as path from 'path';
import * as fs from 'fs';
import { GitHubService } from "./services/githubService";
import { GitService } from "./services/gitService";
import { platform, homedir } from 'os';
import { Tracker } from './services/tracker';
import { SummaryGenerator } from './services/summaryGenerator';
import { Scheduler } from './services/scheduler';
import { Buffer } from 'node:buffer';
import { channel } from 'node:diagnostics_channel';


interface AnthraxServices {
    outputChannel: vscode.OutputChannel,
    githubService: GitHubService,
    gitService: GitService,
    tracker: Tracker;
    summaryGenerator: SummaryGenerator;
    scheduler: Scheduler | null;
    trackingStatusBar: vscode.StatusBarItem;
    authStatusBar: vscode.StatusBarItem;
    extensionContext: vscode.ExtensionContext;
}

interface PersistedAuthState {
    username?: string,
    reponame?: string,
    lastWorkspace?: string,
}

class GitInstallationHandler {

    private static readonly DOWNLOAD_URLS = {
        win32: 'https://git-scm.com/download/win',
        darwin: 'https://git-scm.com/download/mac',
        linux: 'https://git-scm.com/download/linux',
    };

    static async checkGitIntstallation(outputChannel: vscode.OutputChannel): Promise<boolean> {
        try {
            const gitVersion = execSync('git --version', { encoding: 'utf8' });

            outputChannel.appendLine(`anthrax: Git found - ${gitVersion.trim()}`);

            return true;
        } catch (error) {
            const platform = process.platform;
            const response = await vscode.window.showErrorMessage(
                'Git is required but not found on your system. This might be because Git is not installed or not in your system PATH.',
                {
                    modal: true,
                    detail:
                        'Would you like to view the installation guide or fix PATH issues?',
                },
                ...(platform === 'win32'
                    ? ['Show Installation Guide', 'Fix PATH Issue', 'Cancel']
                    : ['Show Installation Guide', 'Cancel'])
            );

            if (response === 'Show Installation Guide') {
                this.showInstallationGuide();
            } else if (response === 'Fix PATH Issue') {
                this.showPathFixGuide();
            }
            return false;
        }
    }

    private static showPathFixGuide(): void {
        const panel = vscode.window.createWebviewPanel(
            'gitPathGuide',
            'Fix Git PATH Issue',
            vscode.ViewColumn.One,
            { enableScripts: true }
        );

        panel.webview.html = `<!DOCTYPE html>
        <html>
          <head>
            <style>
              body { padding: 20px; font-family: system-ui; line-height: 1.6; }
              .step { margin-bottom: 20px; padding: 15px; background-color: #f3f3f3; border-radius: 5px; }
              .warning { color: #856404; background-color: #fff3cd; padding: 10px; border-radius: 5px; }
            </style>
          </head>
          <body>
            <h1>Adding Git to System PATH</h1>
            <div class="warning">⚠️ Ensure Git is installed before proceeding.</div>
            <div class="step">
              <h3>Steps:</h3>
              <ol>
                <li>Open System Properties (Windows + R, type sysdm.cpl)</li>
                <li>Go to Advanced tab</li>
                <li>Click Environment Variables</li>
                <li>Under System Variables, find and select Path</li>
                <li>Click Edit</li>
                <li>Add Git paths:
                  <ul>
                    <li>C:\\Program Files\\Git\\cmd</li>
                    <li>C:\\Program Files\\Git\\bin</li>
                  </ul>
                </li>
                <li>Click OK on all windows</li>
                <li>Restart VS Code</li>
              </ol>
            </div>
          </body>
        </html>`;
    }

    public static showInstallationGuide(): void {
        const panel = vscode.window.createWebviewPanel(
            'gitInstallGuide',
            'Git Installation Guide',
            vscode.ViewColumn.One,
            { enableScripts: true }
        );

        const currentPlatform = platform();
        const downloadUrl =
            this.DOWNLOAD_URLS[currentPlatform as keyof typeof this.DOWNLOAD_URLS];
        const instructions = this.getInstructions(currentPlatform);
        panel.webview.html = this.getWebviewContent(instructions, downloadUrl);
    }

    private static getInstructions(platform: string): string {
        const instructions: Record<string, string> = {
            win32: `Windows Installation:
    1. Download Git from ${this.DOWNLOAD_URLS.win32}
    2. Run installer
    3. Select "Git from command line and 3rd-party software"
    4. Select "Use Windows' default console"
    5. Enable Git Credential Manager
    6. Complete installation
    7. Open new terminal and verify with 'git --version'`,
            darwin: `Mac Installation:
    Option 1 (Homebrew):
    1. Install Homebrew: /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    2. Run: brew install git
    
    Option 2 (Direct):
    1. Download from ${this.DOWNLOAD_URLS.darwin}
    2. Install the package`,
            linux: `Linux Installation:
    Debian/Ubuntu:
    1. sudo apt-get update
    2. sudo apt-get install git
    
    Fedora:
    1. sudo dnf install git`,
        };

        return instructions[platform] || instructions.linux;
    }

    private static getWebviewContent(
        instructions: string,
        downloadUrl: string
    ): string {
        return `<!DOCTYPE html>
    <html>
      <head>
        <style>
          body { padding: 20px; font-family: system-ui; line-height: 1.6; }
          pre { background-color: #f3f3f3; padding: 15px; border-radius: 5px; }
          .download-btn { 
            padding: 10px 20px;
            background-color: #007acc;
            color: white;
            border-radius: 5px;
            text-decoration: none;
            display: inline-block;
            margin-top: 20px;
          }
        </style>
      </head>
      <body>
        <h1>Git Installation Guide</h1>
        <pre>${instructions}</pre>
        <a href="${downloadUrl}" class="download-btn" target="_blank">Download Git</a>
      </body>
    </html>`;
    }
}

function showWelcomeInfo(outputChannel: vscode.OutputChannel): void {
    const welcomeMessage = `
To get started with Anthrax, you'll need:
1. A GitHub account
2. An open workspace/folder
3. Git installed on your system

Anthrax will:
- Create a private GitHub repository to store your coding activity
- Automatically track and commit your changes
- Generate detailed summaries of your work
`;

    vscode.window
        .showInformationMessage(welcomeMessage, 'Set Up Now', 'Later')
        .then((choice) => {
            if (choice === 'Set Up Now') {
                vscode.commands.executeCommand('anthrax.login');
            }
        });
}

// Welcome Message
function showWelcomeMessage(context: vscode.ExtensionContext, services: AnthraxServices): void {
    if (!context.globalState.get('anthraxWelcomeShown')) {
        const message = 'Welcome to Anthrax! Would you like to set up automatic code tracking?';

        vscode.window
            .showInformationMessage(message, 'Get Started', 'Learn More', 'Later')
            .then((selection) => {
                if (selection === 'Get Started') {
                    vscode.commands.executeCommand('anthrax.login');
                } else if (selection === 'Learn More') {
                    showWelcomeInfo(services.outputChannel);
                }
            });

        context.globalState.update('anthraxWelcomeShown', true);
    }
}


function createStatusBarItem(type: 'tracking' | 'auth'): vscode.StatusBarItem {
    const item = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Right,
        type === 'tracking' ? 100 : 101
    );

    if (type === 'tracking') {
        item.text = '$(circle-slash) Anthrax: Stopped';
        item.tooltip = 'Click to start/stop tracking';
        item.command = 'anthrax.startTracking';
    } else {
        item.text = '$(mark-github) Anthrax: Not Connected';
        item.tooltip = 'Click to connect to GitHub';
        item.command = 'anthrax.login';
    }

    return item;
}

// UI Updates
function updateStatusBar(services: AnthraxServices, type: 'tracking' | 'auth', active: boolean): void {
    if (type === 'tracking') {
        services.trackingStatusBar.text = active
            ? '$(clock) anthrax: Tracking'
            : '$(circle-slash) anthrax: Stopped';
        services.trackingStatusBar.tooltip = active
            ? 'Click to stop tracking'
            : 'Click to start tracking';
        services.trackingStatusBar.command = active
            ? 'anthrax.stopTracking'
            : 'anthrax.startTracking';
    } else {
        services.authStatusBar.text = active
            ? '$(check) anthrax: Connected'
            : '$(mark-github) anthrax: Not Connected';
        services.authStatusBar.tooltip = active
            ? 'Click to logout'
            : 'Click to connect to GitHub';
        services.authStatusBar.command = active
            ? 'anthrax.logout'
            : 'anthrax.login';
    }
}

async function restoreAuthState(context: vscode.ExtensionContext, services: AnthraxServices): Promise<boolean> {
    try {
        const persistedState = context.globalState.get<PersistedAuthState>('anthraxAuthState');
        const config = vscode.workspace.getConfiguration('anthrax');
        const repoName = config.get<string>('repoName') || persistedState?.reponame || 'code-tracking';

        services.outputChannel.appendLine('Anthrax: Starting setup process...');

        let session = await vscode.authentication.getSession(
            'github',
            ['repo', 'read:user', 'workflow'], // Added 'workflow' scope
            { createIfNone: false, silent: true }
        );
        let username: string | null;

        const isFreshInstall = !persistedState || !session;

        if (isFreshInstall) {
            services.outputChannel.appendLine('Anthrax: Fresh install detected, prompting for GitHub auth...');
            session = await vscode.authentication.getSession(
                'github',
                ['repo', 'read:user', 'workflow'], // Added 'workflow' scope
                { createIfNone: true }
            );
            if (!session) {
                services.outputChannel.appendLine('Anthrax: GitHub authentication canceled.');
                return false;
            }
        } else if (!session) {
            services.outputChannel.appendLine('Anthrax: No active GitHub session found.');
            return false;
        }

        services.githubService.setToken(session.accessToken);
        username = await services.githubService.getUsername();
        if (!username) {
            services.outputChannel.appendLine('Anthrax: Failed to retrieve GitHub username.');
            return false;
        }

        const remoteUrl = `https://x-access-token:${session.accessToken}@github.com/${username}/${repoName}.git`;
        services.outputChannel.appendLine(`Anthrax: Using remote URL: ${remoteUrl.replace(/x-access-token:[^@]+@/, 'x-access-token:[hidden]@')}`);

        if (isFreshInstall) {
            const repoExists = await services.githubService.repoExists(repoName);
            if (!repoExists) {
                const createdRepoUrl = await services.githubService.createRepo(repoName);
                services.outputChannel.appendLine(`Anthrax: Created GitHub repository at ${createdRepoUrl}`);
                if (!createdRepoUrl) {
                    throw new Error('Failed to create GitHub repository.');
                }
                await services.gitService.initializeRepo(remoteUrl);
            } else {
                await services.gitService.ensureRepoSetup(remoteUrl);
            }
        } else {
            await services.gitService.ensureRepoSetup(remoteUrl);
        }

        await initializeTracker(services);

        if (isFreshInstall) {
            await context.globalState.update('anthraxAuthState', {
                username,
                reponame: repoName,
                lastWorkspace: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
            });
            services.outputChannel.appendLine('Anthrax: Saved initial authentication state.');
        }

        updateStatusBar(services, 'auth', true);
        updateStatusBar(services, 'tracking', true);
        services.outputChannel.appendLine(`Anthrax: ${isFreshInstall ? 'Initialized' : 'Restored'} successfully`);

        return true;

    } catch (error) {
        services.outputChannel.appendLine(`Anthrax: Error in setup - ${error}`);
        return false;
    }
}

async function initializeServices(context: vscode.ExtensionContext, channel: vscode.OutputChannel): Promise<AnthraxServices | null> {
    try {
        const homeDir = homedir();
        if (!homeDir) {
            throw new Error('Unable to determine Home Dir');
        }

        const trackingBase = path.join(homeDir, '.anthrax', 'tracking');
        await fs.promises.mkdir(trackingBase, { recursive: true });

        const workspaceId = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
            ? Buffer.from(vscode.workspace.workspaceFolders[0].uri.fsPath).toString('base64').replace(/[/+=]/g, '_')
            : 'default';
        const trackingDir = path.join(trackingBase, workspaceId);
        await fs.promises.mkdir(trackingDir, { recursive: true });

        const services: AnthraxServices = {
            outputChannel: channel,
            githubService: new GitHubService(channel),
            gitService: new GitService(channel),
            tracker: new Tracker(channel, trackingDir),
            summaryGenerator: new SummaryGenerator(channel, context),
            scheduler: null,
            trackingStatusBar: createStatusBarItem('tracking'),
            authStatusBar: createStatusBarItem('auth'),
            extensionContext: context,
        };

        context.subscriptions.push(services.trackingStatusBar, services.authStatusBar);
        services.trackingStatusBar.show();
        services.authStatusBar.show();

        const isSetup = await restoreAuthState(context, services);
        if (!isSetup) {
            channel.appendLine('Anthrax: Setup failed. Run "Anthrax: Login" to retry.');
            return services;
        }

        return services;

    } catch (error) {
        channel.appendLine(`Anthrax: Service initialization error - ${error}`);
        return null;
    }
}

async function clearGlobalState(services: AnthraxServices) {
    await services.extensionContext.globalState.update('anthraxAuthState', undefined);
    services.outputChannel.appendLine('Anthrax: Cleared global state.');
    vscode.window.showInformationMessage('Anthrax: Global state cleared.');
}

async function registerCommands(context: vscode.ExtensionContext, services: AnthraxServices): Promise<void> {
    const commands = [
        {
            command: 'anthrax.startTracking',
            callback: () => handleStartTracking(services),
        },
        {
            command: 'anthrax.stopTracking',
            callback: () => handleStopTracking(services),
        },
        {
            command: 'anthrax.login',
            callback: () => handleLogin(services),
        },
        {
            command: 'anthrax.logout',
            callback: () => handleLogout(services),
        },
        // Add missing commands
        {
            command: 'anthrax.showGitGuide',
            callback: () => GitInstallationHandler.showInstallationGuide(),
        },
        {
            command: 'anthrax.openFolder',
            callback: () => vscode.commands.executeCommand('vscode.openFolder'),
        },
        {
            command: 'anthrax.clearState',
            callback: () => clearGlobalState(services),
        }
        // Note: We'll register generateWebsite separately in registerWebsiteCommands
    ];

    commands.forEach(
        ({ command, callback }) => {
            context.subscriptions.push(vscode.commands.registerCommand(command, callback));
        });
}


async function handleLogout(services: AnthraxServices): Promise<void> {
    const confirm = await vscode.window.showWarningMessage(
        'Are you sure you want to logout from anthrax?',
        { modal: true },
        'Yes',
        'No'
    );

    if (confirm !== 'Yes') {
        return;
    }

    try {
        cleanUp(services);
        await services.extensionContext.globalState.update(
            'anthraxAuthState',
            undefined
        );
        vscode.window.showInformationMessage('anthrax: Successfully logged out.');

        const loginChoice = await vscode.window.showInformationMessage(
            'Would you like to log in with a different account?',
            'Yes',
            'No'
        );

        if (loginChoice === 'Yes') {
            await vscode.commands.executeCommand('anthrax.login');
        }
    } catch (error: any) {
        handleError(services, 'Logout failed', error);
    }
}

function cleanUp(services: AnthraxServices): void {
    try {
        services.githubService.setToken('');

        updateStatusBar(services, 'auth', false);

        services.outputChannel.appendLine('Anthrax: Cleaned up services');

    } catch (error: any) {
        handleError(services, 'Cleanup - Error', error);
    }
}

// Error Handling
function handleError(services: AnthraxServices, context: string, error: Error): void {
    const message = error.message || 'An unknown error occurred';

    services.outputChannel.appendLine(`ANTHRAX: ${context} - ${message}`);

    vscode.window.showErrorMessage(`ANTHRAX: ${message}`);
}

async function handleLogin(services: AnthraxServices): Promise<void> {
    try {
        services.outputChannel.appendLine('Anthrax: Starting login process...');
        const session = await vscode.authentication.getSession(
            'github',
            ['repo', 'read:user', 'workflow'], // Added 'workflow' scope
            { createIfNone: true }
        );

        if (session) {
            services.githubService.setToken(session.accessToken);
            await initializeAnthrax(services);
        } else {
            vscode.window.showInformationMessage('Anthrax: GitHub connection was cancelled.');
        }

    } catch (error: any) {
        handleError(services, 'Login-Failed', error);
    }
}


async function handleStartTracking(services: AnthraxServices): Promise<void> {
    try {
        if (!vscode.workspace.workspaceFolders?.length) {
            throw new Error('Please Open a workspace before start tracking');
        }

        const gitInstalled = await GitInstallationHandler.checkGitIntstallation(services.outputChannel);
        if (!gitInstalled) {
            return
        }

        if (services.scheduler) {
            services.scheduler.start();

            updateStatusBar(services, 'tracking', true);
            vscode.window.showInformationMessage('Anthrax: Tracking started.');
        } else {
            const response = await vscode.window.showInformationMessage(
                'Anthrax needs to be set up before starting. Would you like to set it up now?',
                'Set Up Anthrax',
                'Cancel'
            );

            if (response === 'Set Up Anthrax') {
                await initializeAnthrax(services);
            }
        }
    } catch (error) {
        handleError(services, 'Error starting tracking', error as Error);
    }
}


async function handleStopTracking(services: AnthraxServices): Promise<void> {
    if (services.scheduler) {
        services.scheduler.stop();
        updateStatusBar(services, 'tracking', false);
        vscode.window.showInformationMessage('Anthrax: Tracking stopped.');
    } else {
        vscode.window.showErrorMessage('Anthrax: Please connect to GitHub first.');
    }
}

// Anthrax Intialization
async function initializeAnthrax(services: AnthraxServices): Promise<void> {
    try {
        services.outputChannel.appendLine('Anthrax: Starting initialization...');
        if (!(await GitInstallationHandler.checkGitIntstallation(services.outputChannel))) {
            throw new Error('Git must be installed before ANTHRAX can be initialized.');
        }

        const session = await vscode.authentication.getSession(
            'github',
            ['repo', 'read:user', 'workflow'], // Added 'workflow' scope
            { createIfNone: true }
        );

        if (!session) {
            throw new Error('GitHub authentication is required to use Anthrax.');
        }

        services.githubService.setToken(session.accessToken);
        const username = await services.githubService.getUsername();
        if (!username) {
            throw new Error('Unable to retrieve GitHub username.');
        }

        const config = vscode.workspace.getConfiguration('anthrax');
        const repoName = config.get<string>('repoName') || 'code-tracking';
        const remoteUrl = `https://x-access-token:${session.accessToken}@github.com/${username}/${repoName}.git`;

        const repoExists = await services.githubService.repoExists(repoName);
        if (!repoExists) {
            const createdRepoUrl = await services.githubService.createRepo(repoName);
            services.outputChannel.appendLine(`Custom created Repo URL: ${createdRepoUrl}`);
            if (!createdRepoUrl) {
                throw new Error('Failed to create GitHub repository.');
            }
        }

        await services.gitService.ensureRepoSetup(remoteUrl);
        await initializeTracker(services);

        updateStatusBar(services, 'auth', true);
        updateStatusBar(services, 'tracking', true);

        await services.extensionContext.globalState.update('anthraxAuthState', {
            username,
            repoName,
            lastWorkspace: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
        });

        services.outputChannel.appendLine('Anthrax: Initialization completed successfully');
        vscode.window.showInformationMessage('Anthrax has been set up successfully and tracking has started.');

    } catch (error: any) {
        handleError(services, 'Initialization Failed', error);
        throw error;
    }
}

async function initializeTracker(services: AnthraxServices): Promise<void> {
    const config = vscode.workspace.getConfiguration('anthrax');
    const commitFrequency = config.get<number>('commitFrequency') || 30;

    services.scheduler = new Scheduler(
        commitFrequency,
        services.tracker,
        services.summaryGenerator,
        services.gitService,
        services.outputChannel
    );

    services.scheduler.start();
    services.outputChannel.appendLine(`Anthrax: Tracker initialized with ${commitFrequency} minute intervals`);
}


export async function activate(context: vscode.ExtensionContext): Promise<void> {
    // Creates an Output Channel First to be used throughout
    const channel = vscode.window.createOutputChannel('Anthrax');
    context.subscriptions.push(channel);
    channel.appendLine('Anthrax: Extension activating...');

    try {
        // Register Test Command
        const testCommand = vscode.commands.registerCommand('anthrax.test', () => {
            vscode.window.showInformationMessage('Anthrax Debug Version: Test Command Executed');
            channel.appendLine('Anthrax Debug Version: Test Command Executed');
        });

        context.subscriptions.push(testCommand);

        // Intialize services with the created channel
        const services = await initializeServices(context, channel);
        if (!services) {
            return;
        }

        // Register commands and setup handlers
        await registerCommands(context, services);

        await registerWebsiteCommands(context, services);

        setupConfigurationHandling(services);
        showWelcomeMessage(context, services);

        channel.appendLine('Anthrax: Extension activated successfully');

    } catch (error) {
        channel.appendLine(`Anthrax: Activation error - ${error}`);
        vscode.window.showErrorMessage('Anthrax: Failed to activate extension');
    }
}


// Configuration Handling
function setupConfigurationHandling(services: AnthraxServices): void {
    vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('anthrax')) {
            handleConfigurationChange(services);
        }
    });
}


async function handleConfigurationChange(services: AnthraxServices): Promise<void> {
    try {
        const config = vscode.workspace.getConfiguration('anthrax');

        // Update commit frequency if scheduler exists
        if (services.scheduler) {
            const newFrequency = config.get<number>('commitFrequency') || 30;
            services.scheduler.updateFrequency(newFrequency);

            services.outputChannel.appendLine(`Anthrax: Updated commit frequency to ${newFrequency} minutes`);
        }

        // Update exclude patterns
        const newExcludePatterns = config.get<string[]>('exclude') || [];
        services.tracker.updateExcludePatterns(newExcludePatterns);
        services.outputChannel.appendLine('Anthrax: Updated exclude patterns');
    } catch (error: any) {
        handleError(services, 'Configuration update failed', error);
    }
}


async function registerWebsiteCommands(context: vscode.ExtensionContext, services: AnthraxServices): Promise<void> {
    services.outputChannel.appendLine('Anthrax: Registering website commands...');

    // Register command to manually generate website
    const generateWebsiteCommand = vscode.commands.registerCommand('anthrax.generateWebsite',
        async () => {
            try {

                vscode.window.withProgress(
                    {
                        location: vscode.ProgressLocation.Notification,
                        title: 'Anthrax: Generating Statistics website',
                        cancellable: false,
                    },

                    async (task) => {
                        task.report({ message: 'Initializing...' });

                        // Import WebsiteGenerator dynamically to avoid circular dependencies
                        const { WebsiteGenerator } = await import('./services/websiteGenerator');

                        // Get homeDir and Tracking dir
                        const homeDir = homedir();

                        // Create workspace-specific tracking directory
                        const workspaceId = vscode.workspace.workspaceFolders?.[0]?.uri
                            .fsPath
                            ? Buffer.from(vscode.workspace.workspaceFolders[0].uri.fsPath)
                                .toString('base64')
                                .replace(/[/+=]/g, '_')
                            : 'default';
                        const trackingDir = path.join(
                            homeDir,
                            '.anthrax',
                            'tracking',
                            workspaceId
                        );

                        task.report({ message: 'Generating website Files' });

                        // Create website generator
                        const websiteGenerator = new WebsiteGenerator(services.outputChannel, trackingDir);
                        await websiteGenerator.generateWebsite();

                        task.report({ message: 'Commiting changes...' });


                        if (!(await services.githubService.repoExists(trackingDir))) {
                            services.outputChannel.appendLine(
                                `anthrax: Failed to verfiy repo`
                            );
                        }

                        // Instead of directly accessing git, use commitAndPush method
                        await services.gitService.commitAndPush('Anthrax: Update Statistics Website');

                        task.report({ message: 'Done!' });

                        // Show success message with GitHub Pages URL
                        const username = await services.githubService.getUsername();
                        const config = vscode.workspace.getConfiguration('anthrax');
                        const repoName = config.get<string>('repoName') || 'code-tracking';

                        if (username) {
                            const pagesUrl = `https://${username}.github.io/${repoName}/`;

                            const viewWebsite = 'View Website';
                            vscode.window
                                .showInformationMessage(`anthrax: Statistics website generated and pushed to GitHub. It should be available soon at ${pagesUrl}`,
                                    viewWebsite)
                                .then((selection) => {
                                    if (selection === viewWebsite) {
                                        vscode.env.openExternal(vscode.Uri.parse(pagesUrl));
                                    }
                                });
                        } else {
                            vscode.window.showInformationMessage(
                                'anthrax: Statistics website generated and pushed to GitHub. It should be available soon.'
                            );
                        }
                    }
                );
            } catch (error: any) {
                services.outputChannel.appendLine(
                    `anthrax: Failed to generate website - ${error.message}`
                );
                vscode.window.showErrorMessage(
                    `anthrax: Failed to generate website - ${error.message}`
                );
            }
        }
    );

    context.subscriptions.push(generateWebsiteCommand);
    services.outputChannel.appendLine('Anthrax: Website commands registered successfully.');
}

export function deactivate() { }

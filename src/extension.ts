import * as vscode from 'vscode';
import { StatusBarManager } from './services/statusBarManager';
import { GitHubService } from "./services/githubService";
import { execSync } from 'child_process';
import process from 'process';
import { error } from 'console';
import * as path from 'path';
import * as fs from 'fs';
import { GitService } from "./services/gitService";
import { platform, homedir } from 'os';
import { Stream } from 'stream';
import { serialize } from 'v8';

interface AnthraxServices {
    outputChannel: vscode.OutputChannel,
    githubService: GitHubService,
    gitService: GitService,
    trackingStatusBar: vscode.StatusBarItem;
    authStatusBar: vscode.StatusBarItem;
    extensionContext: vscode.ExtensionContext;
}

interface PersistedAuthSate {
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
        const persistedState = context.globalState.get<PersistedAuthSate>('anthraxAuthState');
        if (!persistedState?.username) {
            return false
        }

        const session = await vscode.authentication.getSession(
            'github',
            ['repo', 'read:user'],
            {
                createIfNone: false,
                silent: true,
            }
        );


        if (session) {
            services.githubService.setToken(session.accessToken);
            const username = await services.githubService.getUsername();

            if (username == persistedState.username) {
                const repoName = persistedState.reponame || 'code-tracking';
                const remoteUrl = `https://github.com/${username}/${repoName}.git`;

                await services.gitService.ensureRepoSetup(remoteUrl);
                // await intializeTracker(services);

                updateStatusBar(services, 'auth', true);
                // updateStatusBar(services, 'tracking', true);

                services.outputChannel.appendLine('anthrax: Successfully restored authentication state');

                return true;
            }
        }

    } catch (error) {
        services.outputChannel.appendLine(`anthrax: Error restoring auth state - ${error}`);
    }
    return false;
}

async function intializeServices(context: vscode.ExtensionContext, channel: vscode.OutputChannel): Promise<AnthraxServices | null> {
    try {
        const homeDir = homedir();
        if (!homeDir) {
            throw new Error('Unable to determine Home Dir');
        }

        // Create Tracking Dir structure
        const trackingBase = path.join(homeDir, '.anthrax', 'tracking');
        await fs.promises.mkdir(trackingBase, { recursive: true });

        // Create workspace specific Tracking Dir
        const workspaceId = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
            ? Buffer.from(vscode.workspace.workspaceFolders[0].uri.fsPath)
                .toString('base64')
                .replace(/[/+=]/g, '_')
            : 'default';
        const trackingDir = path.join(trackingBase, workspaceId);
        await fs.promises.mkdir(trackingDir, { recursive: true });


        const services: AnthraxServices = {
            extensionContext: context,
            outputChannel: channel,
            githubService: new GitHubService(channel),
            gitService: new GitService(channel),
            trackingStatusBar: createStatusBarItem('tracking'),
            authStatusBar: createStatusBarItem('auth'),
        };


        // Add Status-bar to subscription to show them
        context.subscriptions.push(
            services.trackingStatusBar,
            services.authStatusBar
        );
        services.trackingStatusBar.show();
        services.authStatusBar.show();


        await restoreAuthState(context, services);

        return services;

    } catch (error) {
        channel.appendLine(`Anthrax: Service initialization error - ${error}`);
        return null;
    }
}

async function registerCommands(context: vscode.ExtensionContext, services: AnthraxServices): Promise<void> {
    const commands = [
        // {
        //     command: 'anthrax.startTracking',
        //     callback: () => handleStartTracking(services),
        // },
        // {
        //     command: 'anthrax.stopTracking',
        //     callback: () => handleStopTracking(services),
        // },
        {
            command: 'anthrax.login',
            callback: () => handleLogin(services),
        },
        // {
        //     command: 'anthrax.logout',
        //     callback: () => handleLogout(services),
        // },
        // Add missing commands
        {
            command: 'anthrax.showGitGuide',
            callback: () => GitInstallationHandler.showInstallationGuide(),
        },
        {
            command: 'anthrax.openFolder',
            callback: () => vscode.commands.executeCommand('vscode.openFolder'),
        },
        // Note: We'll register generateWebsite separately in registerWebsiteCommands
    ];

    commands.forEach(
        ({ command, callback }) => {
            context.subscriptions.push(vscode.commands.registerCommand(command, callback));
        });
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
            ['repo', 'read:user'],
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

// Anthrax Intialization
async function initializeAnthrax(services: AnthraxServices): Promise<void> {
    try {
        services.outputChannel.appendLine('Anthrax: Starting initialization...');

        // Verify Git installation
        if (!(await GitInstallationHandler.checkGitIntstallation(services.outputChannel))) {
            throw new Error('Git must be installed before ANTHRAX can be initialized.');
        }

        // Get Github Session
        const session = vscode.authentication.getSession(
            'github',
            ['repo', 'read:user'],
            { createIfNone: true },
        );

        if (!session) {
            throw new Error('GitHub authentication is required to use Anthrax.');
        }


        // Initialize Github Services
        services.githubService.setToken((await session).accessToken);
        const username = await services.githubService.getUsername();

        if (!username) {
            throw new Error('Unable to retrieve GitHub username.');
        }


        // Setup Repo
        const config = vscode.workspace.getConfiguration('anthrax');
        const repoName = config.get<string>('repoName') || 'code-tracking';
        const remoteUrl = `https://github.com/${username}/${repoName}.git`;

        // Create repo if it doesnt exist\
        const repoExists = await services.githubService.repoExists(repoName);
        if (!repoExists) {
            const createdRepoUrl = await services.githubService.createRepo(repoName);
            if (!createdRepoUrl) {
                throw new Error('Failed to create GitHub repository.');
            }
        }


        // Intialize Git repo
        await services.gitService.ensureRepoSetup(remoteUrl);

        // Initialize tracker
        // await initializeTracker(services);


        // Update UI and Persist State
        updateStatusBar(services, 'auth', true);
        // updateStatusBar(services, 'tracking' , true);


        await services.extensionContext.globalState.update('anthraxAuthState',
            {
                username,
                repoName,
                lastWorkspace: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
            }
        );

        services.outputChannel.appendLine('Anthrax: Initialization completed successfully');

        vscode.window.showInformationMessage('Anthrax has been set up successfully and tracking has started.');

    } catch (error: any) {
        handleError(services, 'Intialization Failed', error);
        throw error;
    }
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
        const services = await intializeServices(context, channel);
        if (!services) {
            return;
        }

        // Register commands and setup handlers
        await registerCommands(context, services);

    } catch (error) {
        channel.appendLine(`Anthrax: Activation error - ${error}`);
        vscode.window.showErrorMessage('Anthrax: Failed to activate extension');
    }
}


export function deactivate() { }

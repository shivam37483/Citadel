import * as vscode from 'vscode';
import { StatusBarManager } from './services/statusBarManager';
import { GitHubService } from "./services/githubService";
import { execSync } from 'child_process';
import process from 'process';
import { error } from 'console';
import * as path from 'path';
import * as fs from 'fs';
import { GitService } from "./services/gitService";

interface AnthraxServices {
    outputChannel: vscode.OutputChannel,
    githubService: GitHubService,
    gitService: GitService,
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

            outputChannel.appendLine(`DevTrack: Git found - ${gitVersion.trim()}`);

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

    private static showPathFixGuide() {
        const panel = vscode.window.createWebviewPanel(
            'gitPathGuide',
            'Fix Git PATH Issue',
            vscode.ViewColumn.One,
            { enableScripts: true }
        );

        const content = `<!DOCTYPE html>
        <html>
        <head>
            <style>
                body { 
                    padding: 20px; 
                    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
                    line-height: 1.6;
                }
                .step {
                    margin-bottom: 20px;
                    padding: 15px;
                    background-color: #f3f3f3;
                    border-radius: 5px;
                }
                .warning {
                    color: #856404;
                    background-color: #fff3cd;
                    border: 1px solid #ffeeba;
                    padding: 10px;
                    border-radius: 5px;
                    margin: 10px 0;
                }
                .tip {
                    color: #004085;
                    background-color: #cce5ff;
                    border: 1px solid #b8daff;
                    padding: 10px;
                    border-radius: 5px;
                    margin: 10px 0;
                }
                img {
                    max-width: 100%;
                    margin: 10px 0;
                    border: 1px solid #ddd;
                    border-radius: 4px;
                    padding: 5px;
                }
            </style>
        </head>
        <body>
            <h1>Adding Git to System PATH</h1>
            
            <div class="warning">
                ⚠️ Before proceeding, make sure Git is installed on your system. If not, please install it first.
            </div>
    
            <div class="step">
                <h3>Step 1: Open System Properties</h3>
                <ul>
                    <li>Press <strong>Windows + R</strong> to open Run dialog</li>
                    <li>Type <strong>sysdm.cpl</strong> and press Enter</li>
                    <li>Go to the <strong>Advanced</strong> tab</li>
                    <li>Click <strong>Environment Variables</strong> at the bottom</li>
                </ul>
            </div>
    
            <div class="step">
                <h3>Step 2: Edit PATH Variable</h3>
                <ul>
                    <li>Under <strong>System Variables</strong>, find and select <strong>Path</strong></li>
                    <li>Click <strong>Edit</strong></li>
                    <li>Click <strong>New</strong></li>
                    <li>Add the following paths (if they don't already exist):
                        <ul>
                            <li>C:\\Program Files\\Git\\cmd</li>
                            <li>C:\\Program Files\\Git\\bin</li>
                            <li>C:\\Program Files (x86)\\Git\\cmd</li>
                        </ul>
                    </li>
                    <li>Click <strong>OK</strong> on all windows</li>
                </ul>
            </div>
    
            <div class="step">
                <h3>Step 3: Verify Installation</h3>
                <ul>
                    <li>Open a <strong>new</strong> Command Prompt or PowerShell window</li>
                    <li>Type <strong>git --version</strong> and press Enter</li>
                    <li>If you see a version number, Git is successfully added to PATH</li>
                </ul>
            </div>
    
            <div class="tip">
                💡 Tip: If Git is installed in a different location, you'll need to add that path instead. 
                Common alternative locations:
                <ul>
                    <li>C:\\Program Files\\Git\\cmd</li>
                    <li>C:\\Users\\[YourUsername]\\AppData\\Local\\Programs\\Git\\cmd</li>
                </ul>
            </div>
    
            <div class="warning">
                Important: After updating the PATH, you need to:
                <ol>
                    <li>Close and reopen VS Code</li>
                    <li>Close and reopen any open terminal windows</li>
                </ol>
            </div>
        </body>
        </html>`;

        panel.webview.html = content;
    }

    static showInstallationGuide() {
        const platform = process.platform;
        const downloadUrl = this.DOWNLOAD_URLS[platform as keyof typeof this.DOWNLOAD_URLS];
        const instructions = this.getInstructions(platform);

        const panel = vscode.window.createWebviewPanel(
            'gitInstallGuide',
            'Git Installation Guide',
            vscode.ViewColumn.One,
            { enableScripts: true }
        );

        panel.webview.html = this.getWebviewContent(instructions, downloadUrl);
    }

    private static getInstructions(platform: string): string {
        const instructions = {
            win32: `Windows Git Installation Guide:
    1. Download Git from ${this.DOWNLOAD_URLS.win32}
    2. Run the installer
    3. During installation:
       - Choose "Git from the command line and also from 3rd-party software"
       - Choose "Use Windows' default console window"
       - Choose "Enable Git Credential Manager"
    4. Important: On the "Adjusting your PATH environment" step:
       - Select "Git from the command line and also from 3rd-party software"
    5. Complete the installation
    6. Verify installation:
       - Open a new Command Prompt or PowerShell
       - Type 'git --version'`,
            darwin: `Mac Git Installation Guide:
    Option 1 - Using Homebrew (Recommended):
    1. Open Terminal
    2. Install Homebrew if not installed:
       /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    3. Install Git:
       brew install git
    
    Option 2 - Direct Download:
    1. Download Git from ${this.DOWNLOAD_URLS.darwin}
    2. Open the downloaded .dmg file
    3. Run the installer package`,
            linux: `Linux Git Installation Guide:
    Debian/Ubuntu:
    1. Open Terminal
    2. Run: sudo apt-get update
    3. Run: sudo apt-get install git
    
    Fedora:
    1. Open Terminal
    2. Run: sudo dnf install git`,
        };

        return (
            instructions[platform as keyof typeof instructions] || instructions.linux
        );
    }

    private static getWebviewContent(
        instructions: string,
        downloadUrl: string
    ): string {
        return `<!DOCTYPE html>
        <html>
        <head>
            <style>
                body { 
                    padding: 20px; 
                    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; 
                    line-height: 1.6;
                }
                pre { 
                    white-space: pre-wrap; 
                    background-color: #f3f3f3; 
                    padding: 15px; 
                    border-radius: 5px; 
                }
                .download-btn { 
                    padding: 10px 20px; 
                    background-color: #007acc; 
                    color: white; 
                    border: none; 
                    border-radius: 5px;
                    cursor: pointer;
                    margin-top: 20px;
                    text-decoration: none;
                    display: inline-block;
                }
                .download-btn:hover { 
                    background-color: #005999; 
                }
                .tip {
                    background-color: #e8f5e9;
                    padding: 10px;
                    border-radius: 5px;
                    margin: 10px 0;
                }
            </style>
        </head>
        <body>
            <h1>Git Installation Guide</h1>
            <pre>${instructions}</pre>
            <div class="tip">
                <strong>Tip:</strong> After installation, if Git is not recognized:
                <ul>
                    <li>Make sure to restart VS Code</li>
                    <li>Open a new terminal window</li>
                    <li>If still not working, you might need to add Git to your PATH</li>
                </ul>
            </div>
            <a href="${downloadUrl}" class="download-btn" target="_blank">Download Git</a>
        </body>
        </html>`;
    }
}

function showWelcomeInfo(outputChannel: vscode.OutputChannel) {
    const msg = 'Welcome to DevTrack! Would you like to set up automatic code tracking?';

    const welcomeMessage = `
To get started with DevTrack, you'll need:
1. A GitHub account
2. An open workspace/folder
3. Git installed on your system (Download from https://git-scm.com/downloads)

DevTrack will:
- Create a private GitHub repository to store your coding activity
- Automatically track and commit your changes
- Generate detailed summaries of your work`;

    GitInstallationHandler.checkGitIntstallation(outputChannel).then(
        (gitInstalled) => {
            if (!gitInstalled) {
                return;
            }

            vscode.window
                .showInformationMessage(msg, 'Get Started', 'Learn More', 'Later')
                .then(
                    (selection) => {
                        if (selection == 'Get Started') {
                            vscode.commands.executeCommand('anthrax.login');
                        } else if (selection == 'Learn More') {
                            vscode.window
                                .showInformationMessage(welcomeMessage, 'Set Up Now', 'Later')
                                .then(
                                    (choice) => {
                                        if (choice == 'Set Up Now') {
                                            vscode.commands.executeCommand('anthrax.login')
                                        }
                                    }
                                )
                        }
                    }
                );
        }
    );
}


async function recoveryFromGitIssues(services: AnthraxServices): Promise<void> {
    try {
        // Clear existing Git state

        // Retrieves the root directory of the currently open VSCode workspace
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
        if (!workspaceRoot) {
            throw new Error('No workspace folder found');
        }

        // Constructs the .git folder path in the workspace
        const gitPath = path.join(workspaceRoot, '.git');
        // If the .git directory exists, it deletes it recursively to remove all Git metadata. This effectively "resets" the repository, ensuring any corrupt or misconfigured state is cleared.
        if (fs.existsSync(gitPath)) {
            await vscode.workspace.fs.delete(vscode.Uri.file(gitPath), {
                recursive: true,
            });
        }


        // Clear the existing session by requesting with createIfNone: false
        try {
            await vscode.authentication.getSession('github', ['repo', 'read:user'], {
                // ensures it does not create a new session
                createIfNone: false,
                // clears any stored authentication preferences
                clearSessionPreference: true,
            });
        } catch (error) {
            // Ignore errors here, just trying to clear the session
        }



    // Reinitialize services
    services.githubService = new GitHubService(services.outputChannel);
    services.gitService = new GitService(services.outputChannel);

    // Get fresh GitHub token
    const session = await vscode.authentication.getSession(
      'github',
      ['repo', 'read:user'],
      {
        createIfNone: true,
        clearSessionPreference: true,
      }
    );

    if (!session) {
      throw new Error('Failed to authenticate with GitHub');
    }

    services.githubService.setToken(session.accessToken);

    // Setup repository from scratch
    const username = await services.githubService.getUsername();
    if (!username) {
      throw new Error('Failed to get GitHub username');
    }

    const config = vscode.workspace.getConfiguration('devtrack');
    const repoName = config.get<string>('repoName') || 'code-tracking';
    const remoteUrl = `https://github.com/${username}/${repoName}.git`;

    await services.gitService.initializeRepo(remoteUrl);

  } catch (error: any) {
    throw new Error(`Recovery failed: ${error.message}`);
  }
}


export async function activate(context: vscode.ExtensionContext) {
    // console.log("Anthrax extension activated!"); // Debugging line

    let statusBarManager = new StatusBarManager();

    let dummy = vscode.commands.registerCommand('anthrax.test', () => {
        vscode.window.showInformationMessage("Beginnign of a whole new goddamn world");
        // console.log("Anthrax extension Displayed something!"); // Debugging line
    });

    context.subscriptions.push(dummy);



    // const outputChannel = vscode.window.createOutputChannel('Anthrax');
    // const githubService = new GitHubService(outputChannel);
    // const services: AnthraxServices = { outputChannel: outputChannel, githubService: githubService };

    // let recoveryCommand = vscode.commands.registerCommand('anthrax.openFolder', () => {
    //     recovery(services).catch(err => {
    //         vscode.window.showErrorMessage(`Recovery failed: ${err.message}`);
    //     });
    // });
    // context.subscriptions.push(recoveryCommand);


}


export function deactivate() { }


// async function registerCommands(context: vscode.ExtensionContext, services: AnthraxServices) {

// }
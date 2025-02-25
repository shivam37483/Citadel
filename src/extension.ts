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
        // const services = await intializeServices(context, channel);
        // if (!services) {
        //     return;
        // }

    } catch (error) {
        channel.appendLine(`Anthrax: Activation error - ${error}`);
        vscode.window.showErrorMessage('Anthrax: Failed to activate extension');
    }
}


export function deactivate() { }


// async function registerCommands(context: vscode.ExtensionContext, services: AnthraxServices) {

// }
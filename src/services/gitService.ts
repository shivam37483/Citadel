import { Buffer } from 'buffer';
import * as vscode from 'vscode';
import simpleGit, { SimpleGit, SimpleGitOptions } from 'simple-git';
import * as path from 'path';
import { EventEmitter } from 'events';
import { OutputChannel } from 'vscode';
import { promisify } from 'util';
import { exec } from 'child_process';
import { execSync } from 'child_process';
import process from 'process';
const execAsync = promisify(exec);
import * as fs from 'fs';
import { GitHubService } from './githubService';


interface GitServiceEvents {
    commit: (message: string) => void;
    error: (error: Error) => void;
    'operation:start': (operation: string) => void;
    'operation:end': (operation: string) => void;
    retry: (operation: string, attempt: number) => void;
    push: (branch: string) => void;
}

interface TrackingMetadata {
    projectPath: string,
    lastSync: string,
    lastCommit?: {
        message: string,
        timeStamp: string,
        changeCount: number,
    }
    changes?: Array<{
        timeStamp: string,
        files: string[],
        summary: string,
    }>;
}

interface ActivityTimelineEntry {
    date: string,
    commits: number,
    filesChanged: number,
}

interface TimeDistribution {
    hour: number,
    changes: number,
}

interface FileTypeStats {
    name: string,
    count: number,
    percentage: number,
}

interface syncforgeStats {
    totalTime: number;
    filesModified: number;
    totalCommits: number;
    linesChanged: number;
    activityTimeline: ActivityTimelineEntry[];
    timeDistribution: TimeDistribution[];
    fileTypes: FileTypeStats[];
}

interface TimeStampFormat {
    sortable: string,
    readable: string,
}

export class GitService extends EventEmitter {
    private static readonly MAX_LISTENERS = 10;
    private outputChannel: OutputChannel;
    private git!: SimpleGit;          // assert that the git property will be initialized before it is accessed, even though it is not initialized in the constructor
    private repoPath!: string;
    private readonly baseTrackingDir: string;

    private boundListeners: Set<{
        event: keyof GitServiceEvents;
        listener: Function;
    }> = new Set();

    // Indentifies whther platform is windows
    private readonly isWindows: boolean = process.platform === 'win32';

    private projectIdentifier: string = '';
    private currentTrackingDir: string = '';

    // A Promise chain that ensures operations execute in order. Initially, it is set to Promise.resolve(), meaning it is empty, every operation appends itself to this queue, executing only when the previous operation finishes.
    private operationQueue: Promise<any> = Promise.resolve();

    private hasInitializedStats: boolean = false;
    private statsDir: string = '';

    private activeProcesses = 0;
    private static readonly PROCESS_LIMIT = 5;

    private static MAX_RETRIES = 3;
    private static RETRY_DELAY = 1000;

    private processQueue: Promise<any> = Promise.resolve();

    private githubService!: GitHubService;


    private setupDefaultErrorHandler() {
        if (this.listenerCount('error') == 0) {             // Returns the number of listeners listening for the event named eventName
            this.on('error', (error: Error) => {
                this.outputChannel.appendLine(`Syncforge: Unhandled Git error - ${error.message}`);
            });
        }
    }

    constructor(outputChannel: OutputChannel) {
        super();

        this.setMaxListeners(GitService.MAX_LISTENERS);
        this.outputChannel = outputChannel;
        this.setupDefaultErrorHandler();

        // Create Base tracking Directory in User's home. 
        const homeDir = process.env.HOME || process.env.USERPROFILE || '';
        this.baseTrackingDir = path.join(homeDir, '.syncforge');


        // Ensuring base Directory exists
        if (!fs.existsSync(this.baseTrackingDir)) {
            fs.mkdirSync(this.baseTrackingDir, { recursive: true });
        }
    }

    // Type - safe Event Emmiter methods. It extends keyof GitServiceEvents, meaning E must be a key of the GitServiceEvents type. This ensures that event can only be a valid event name defined in GitServiceEvents.
    // listener: The callback function that will be executed when the event occurs. GitServiceEvents[E] ensures that the listener matches the expected function signature for the given event.
    public on<E extends keyof GitServiceEvents>(event: E, listener: GitServiceEvents[E]): this {
        if (event === 'error' && this.listenerCount('error') >= GitService.MAX_LISTENERS - 1) {
            this.outputChannel.appendLine('Syncforge: Warning - Too many error listeners');
            return this;
        }

        this.boundListeners.add({ event, listener });
        return super.on(event, listener);
    }

    // Ensures that a given event listener executes only once and then removes itself. Since E is constrained to GitServiceEvents, this parameter is type-safe and must match one of the event names.
    // this: This allows method chaining, meaning you can call multiple methods on the same object in a single statement.
    public once<E extends keyof GitServiceEvents>(event: E, listener: GitServiceEvents[E]): this {
        // This is a wrapper function that: Calls the original listener with its argument; Removes itself from boundListeners after execution.
        const onceListener = (
            // Uses TypeScript’s Parameters<T> utility type to extract the function's parameters dynamically, This allows the function to accept any number of arguments that match listener ALL STORED IN "args".
            (...args: Parameters<GitServiceEvents[E]>) => {
                // Removes the istance from boundListeners when called
                this.boundListeners.delete({ event, listener });

                // Calls the function using apply(We don’t know how many arguments listener expects, apply() allows passing any number of arguments dynamically)
                return (listener as Function).apply(this, args);
            }
            // (listener as Function).apply(this, args); returns a value, but TypeScript doesn’t know what type it is. To satisfy TypeScript, we cast it twice: as unknown → Temporarily treats it as an unknown type then to: as GitServiceEvents[E] → Casts it back to the expected event listener type.
        ) as unknown as GitServiceEvents[E];

        // Adds the event instance in boundlistener before its removed thru above mentioend functionality.
        this.boundListeners.add({ event, listener: onceListener });

        // Calls the super menthod with customized (stream)
        return super.once(event, onceListener);
    }


    public removeListener<E extends keyof GitServiceEvents>(event: E, listener: GitServiceEvents[E]): this {
        this.boundListeners.delete({ event, listener });

        return super.removeListener(event, listener);
    }


    // Either removes the instance of all the given event or enitire set based on the parameter
    public removeAllListeners(eventName?: keyof GitServiceEvents): this {
        if (eventName) {
            this.boundListeners.forEach(
                (listener) => {
                    if (listener.event === eventName) {
                        this.boundListeners.delete(listener);
                    }
                }
            );

        } else {
            this.boundListeners.clear();
        }

        return super.removeAllListeners(eventName);
    }


    // safe emit with type checking. Return true for events that hv listerners else false.
    protected emitSafe<E extends keyof GitServiceEvents>(event: E, ...args: Parameters<GitServiceEvents[E]>): boolean {
        try {
            if (this.listenerCount(event) === 0 && event != 'error') {
                // IF no listeners for non-error events, log it
                this.outputChannel.appendLine(`Syncforge: No listerners for event - ${String(event)}`);

                return false;
            }

            return super.emit(event, ...args);
        } catch (error) {
            this.outputChannel.appendLine(`Syncforge: Error emitting event ${String(event)}`);

            this.emit('error', new Error(`Event emmsion failed ${error}`));

            return false;
        }
    }


    private async verifyLinuxPermissions(): Promise<void> {
        if (!this.isWindows) {
            try {
                // Check if git commands can be executed
                await execAsync('git --version');

                // Check if .gitconfig is accessible
                const homeDir = process.env.HOME;
                if (homeDir) {
                    const gitConfig = path.join(homeDir, '.gitconfig');
                    try {
                        await fs.promises.access(
                            gitConfig,
                            fs.constants.R_OK | fs.constants.W_OK
                        );
                    } catch {
                        // Create .gitconfig if it doesn't exist
                        await fs.promises.writeFile(gitConfig, '', { mode: 0o644 });
                    }
                }
            } catch (error: any) {
                this.outputChannel.appendLine(
                    `syncforge: Linux permissions check failed - ${error.message}`
                );
                throw new Error(
                    'Git permissions issue detected. Please check your Git installation and permissions.'
                );
            }
        }
    }


    private async checkGitEnvironment(): Promise<void> {
        try {
            const { stdout } = await execAsync('git --version');
            const match = stdout.match(/git version (\d+\.\d+\.\d+)/);
            if (!match) {
                throw new Error('Unable to determine Git version');
            }

            const version = match[1];
            const [major, minor] = version.split('.').map(Number);

            if (major < 2 || (major === 2 && minor < 30)) {
                throw new Error(
                    `Git version ${version} is not supported. Please upgrade to 2.30.0 or later.`
                );
            }

            this.outputChannel.appendLine(
                `syncforge: Git version ${version} verified`
            );
        } catch (error: any) {
            throw new Error(`Git environment check failed: ${error.message}`);
        }
    }


    private findGitExecutable(): string {
        try {
            if (this.isWindows) {
                // Try to get Git path from environment variables first
                const pathEnv = process.env.PATH || '';
                const paths = pathEnv.split(path.delimiter);

                // Always use forward slashes for Windows paths
                for (const basePath of paths) {
                    const gitExePath = path.join(basePath, 'git.exe').replace(/\\/g, '/');
                    if (fs.existsSync(gitExePath)) {
                        this.outputChannel.appendLine(`Syncforge: Found Git in PATH at ${gitExePath}`);

                        return 'git';
                    }
                }


                // Check common installation paths with forward slashes
                const commonPaths = [
                    'C:/Program Files/Git/cmd/git.exe',
                    'C:/Program Files (x86)/Git/cmd/git.exe',
                ];

                for (const gitPath of commonPaths) {
                    if (fs.existsSync(gitPath)) {
                        this.outputChannel.appendLine(`Syncforge: Found Git at ${gitPath}`);
                        return gitPath;
                    }
                }

                // Last resort: try where command
                try {
                    const gitPathFromWhere = execSync('where git', { encoding: 'utf8' })
                        .split('\n')[0]
                        .trim()
                        .replace(/\\/g, '/');

                    if (gitPathFromWhere && fs.existsSync(gitPathFromWhere)) {
                        this.outputChannel.appendLine(`Syncforge: Found Git using 'where' command at ${gitPathFromWhere}`);

                        return gitPathFromWhere;
                    }

                } catch (error) {
                    this.outputChannel.appendLine('Syncforge: Git not found in PATH');
                }

                // Final fallback
                return 'git';
            } else {
                // Unix-like systems
                try {
                    // Try multiple methods to find Git
                    const methods = ['which git', 'command -v git', 'type -p git'];

                    for (const method of methods) {
                        try {
                            const gitPath = execSync(method, { encoding: 'utf8' }).trim();
                            if (gitPath && fs.existsSync(gitPath)) {
                                this.outputChannel.appendLine(
                                    `syncforge: Found Git using '${method}' at ${gitPath}`
                                );
                                return gitPath;
                            }
                        } catch (e) {
                            // Continue to next method
                        }
                    }

                    // Check common Linux paths
                    const commonPaths = [
                        '/usr/bin/git',
                        '/usr/local/bin/git',
                        '/opt/local/bin/git',
                    ];

                    for (const gitPath of commonPaths) {
                        if (fs.existsSync(gitPath)) {
                            this.outputChannel.appendLine(
                                `syncforge: Found Git at ${gitPath}`
                            );
                            return gitPath;
                        }
                    }

                    // Fallback to 'git' and let the system resolve it
                    return 'git';
                } catch {
                    return 'git';
                }
            }
        } catch (error) {
            this.outputChannel.appendLine(
                `syncforge: Error finding Git executable - ${error}`
            );
            return 'git';
        }
    }


    // Create a new directory (for Tracking) usign base TD and unique identifier which is then also git initialized
    private async initializeTracking(): Promise<void> {
        try {
            const workspaceFolders = vscode.workspace.workspaceFolders;

            if (!workspaceFolders || workspaceFolders.length === 0) {
                throw new Error('No workspace folder found is open');
            }

            //  Gets the first workspace folder (assumes a single project is open); .uri.fsPath → Converts the URI into a file system path
            const projectPath = workspaceFolders[0].uri.fsPath;


            // Converts the project path into a binary buffer to create a unique identifier for the project based on its path. Replaces special characters (/, +, =) with _ to make it file system safe.
            this.projectIdentifier = Buffer.from(projectPath)
                .toString('base64')
                .replace(/[/+=]/g, '_');


            // Create project-specific tracking directory in user's home directory
            this.currentTrackingDir = path.join(this.baseTrackingDir, this.projectIdentifier);

            if (!fs.existsSync(this.currentTrackingDir)) {
                await fs.promises.mkdir(this.currentTrackingDir, { recursive: true });
            }


            // Intitalize git in the tracking directory only
            const options: Partial<SimpleGitOptions> = {
                baseDir: this.currentTrackingDir,
                binary: this.findGitExecutable(),
                maxConcurrentProcesses: 1,
            };

            this.git = simpleGit(options);
            this.repoPath = this.currentTrackingDir;

            this.outputChannel.appendLine(`Syncforge: Tracking directory initialized at ${this.currentTrackingDir}`);

        } catch (error: unknown) {
            const errorMessage =
                error instanceof Error ? error.message : String(error);
            this.outputChannel.appendLine(`Syncforge: Tracking initialization failed - ${errorMessage}`);

            throw error;
        }
    }


    private async validateWorkspace(): Promise<boolean> {
        const workspaceFolders = vscode.workspace.workspaceFolders;

        if (!workspaceFolders || workspaceFolders.length === 0) {
            this.outputChannel.appendLine('Syncforge: No workspace folder is open');
            return false;
        }

        // Only validate Git is installed, don't check workspace Git status
        try {
            await this.checkGitEnvironment();
            return true;
        } catch (error) {
            this.outputChannel.appendLine(
                `syncforge: Git validation failed - ${error}`
            );
            return false;
        }
    }


    private async createTrackingDirectory(): Promise<void> {
        try {
            if (!this.currentTrackingDir) {
                const homeDir = process.env.HOME || process.env.USERPROFILE;
                if (!homeDir) {
                    throw new Error('Unable to determine home directory for syncforge');
                }

                // Create a base tracking directory even without workspace
                this.currentTrackingDir = path.join(
                    homeDir,
                    '.syncforge',
                    'tracking',
                    'default'
                );

                // If workspace is available, use workspace-specific directory
                const workspaceFolders = vscode.workspace.workspaceFolders;
                if (workspaceFolders && workspaceFolders.length > 0) {
                    const workspaceId = Buffer.from(workspaceFolders[0].uri.fsPath)
                        .toString('base64')
                        .replace(/[/+=]/g, '_');
                    this.currentTrackingDir = path.join(
                        homeDir,
                        '.syncforge',
                        'tracking',
                        workspaceId
                    );
                }

                if (!fs.existsSync(this.currentTrackingDir)) {
                    await fs.promises.mkdir(this.currentTrackingDir, { recursive: true });
                }

                this.outputChannel.appendLine(`Syncforge: Created tracking directory at ${this.currentTrackingDir}`);
            }

        } catch (error: any) {
            this.outputChannel.appendLine(`Syncforge: Error creating tracking directory - ${error.message}`);

            throw error;
        }
    }


    private async setupRemoteTracking(): Promise<void> {
        try {
            if (!this.git) {
                throw new Error('Git not initialized');
            }

            const branches = await this.git.branch();
            const currentBranch = branches.current;

            // Instead of pulling all files, we'll only push our changes
            try {
                // Set upstream without pulling
                await this.git.push([
                    '--set-upstream',
                    'origin',
                    currentBranch,
                    '--force',
                ]);
                this.outputChannel.appendLine(
                    `syncforge: Set upstream tracking for ${currentBranch}`
                );
            } catch (error) {
                this.outputChannel.appendLine(
                    `syncforge: Failed to set upstream - ${error}`
                );
                throw error;
            }
        } catch (error) {
            this.outputChannel.appendLine(
                `syncforge: Error in setupRemoteTracking - ${error}`
            );
            throw error;
        }
    }

    private async updateTrackingMetadata(data: Partial<TrackingMetadata>): Promise<void> {
        const metadataPath = path.join(this.currentTrackingDir, 'tracking.json');
        let metadata: TrackingMetadata;

        try {
            if (fs.existsSync(metadataPath)) {
                metadata = JSON.parse(await fs.promises.readFile(metadataPath, 'utf8'));
            } else {
                metadata = {
                    projectPath: '',
                    lastSync: new Date().toISOString(),
                    changes: [],
                };
            }

            metadata = { ...metadata, ...data };
            await fs.promises.writeFile(
                metadataPath,
                JSON.stringify(metadata, null, 2)
            );
        } catch (error) {
            this.outputChannel.appendLine(
                'syncforge: Failed to update tracking metadata'
            );
        }
    }

    // Ensures that operations execute sequentially in a queue-like manner. Instead of running multiple Git operations at the same time. It chains them so that each operation executes only after the previous one completes.
    // operation() is asynchronous, meaning it must use await or return a Promise
    private enqueueOperation<T>(operation: () => Promise<T>): Promise<T> {
        // function starts with this.operationQueue, which represents the previous operation in the queue.
        this.operationQueue = this.operationQueue
            // Waits for the previous operation to complete.
            .then(
                // Executes the new operation() only after the previous one finishes.
                () => operation()
            )
            .catch(
                (error) => {
                    this.outputChannel.appendLine(`Syncforge: Operation failed: ${error}`);
                    throw error;
                }
            );

        return this.operationQueue;
    }


    private async setupGitIgnore(): Promise<void> {
        const gitignorePath = path.join(this.currentTrackingDir, '.gitignore');
        const gitignoreContent = `
# syncforge - Only track specific directories
/*

# Allow syncforge directories
!/stats/
!/changes/
!/.gitignore
!/.gitkeep
!/.github/
!/.github/workflows/

# Ensure no workspace files are tracked
*.workspace
*.code-workspace
.vscode/
node_modules/`;

        await fs.promises.writeFile(gitignorePath, gitignoreContent);
        await this.git.add('.gitignore');
        await this.git.commit('Syncforge: Added gitignore to protect workspace');

        this.outputChannel.appendLine(`Syncforge: Gitignore added successfully}`);
    }


    private async initializeStatistics(isNewUser: boolean): Promise<void> {
        if (this.hasInitializedStats) {
            return
        }

        try {
            // Create stats directory if it doesn't exist
            this.statsDir = path.join(this.currentTrackingDir, 'stats');
            if (!fs.existsSync(this.statsDir)) {
                await fs.promises.mkdir(this.statsDir, { recursive: true });

                // Create initial dashboard files
                const dashboardHtml = `
      <!DOCTYPE html>
      <html>
      <head>
        <title>syncforge Statistics</title>
      </head>
      <body>
        <div id="root"></div>
      </body>
      </html>`;

                await fs.promises.writeFile(
                    path.join(this.statsDir, 'index.html'),
                    dashboardHtml
                );

                // Create empty dashboard.js
                await fs.promises.writeFile(
                    path.join(this.statsDir, 'dashboard.js'),
                    '// syncforge Dashboard initialization'
                );
            }

            // Initialize empty stats data
            const initialStats: syncforgeStats = {
                totalTime: 0,
                filesModified: 0,
                totalCommits: 0,
                linesChanged: 0,
                activityTimeline: [] as ActivityTimelineEntry[],
                timeDistribution: [] as TimeDistribution[],
                fileTypes: [] as FileTypeStats[],
            };

            const statsDataPath = path.join(this.statsDir, 'data.json');
            if (!fs.existsSync(statsDataPath)) {
                await fs.promises.writeFile(
                    statsDataPath,
                    JSON.stringify(initialStats, null, 2)
                );
            }

            // Add stats directory to Git only if it's a new user
            if (isNewUser) {
                await this.git.add(path.join(this.statsDir, '*'));
                await this.git.commit('syncforge: Initialize statistics tracking');

                // Push changes only if we have a remote set up
                try {
                    const currentBranch = (await this.git.branch()).current;
                    await this.git.push('origin', currentBranch);
                } catch (pushError) {
                    // Log push error but don't fail initialization
                    this.outputChannel.appendLine(`Syncforge: Warning - Could not push initial stats: ${pushError}`);
                }
            }

            this.hasInitializedStats = true;
            this.outputChannel.appendLine('Syncforge: Statistics tracking initialized successfully');

        } catch (error) {
            this.outputChannel.appendLine(`Syncforge: Failed to initialize statistics - ${error}`);
            // Don't throw the error - allow the app to continue without stats
            this.hasInitializedStats = false;
        }
    }

//     private async setupGitHubWorkflow(): Promise<void> {
//         try {
//             const workflowsDir = path.join(this.currentTrackingDir, '.github', 'workflows');
//             await fs.promises.mkdir(workflowsDir, { recursive: true });
    
//             const workflowPath = path.join(workflowsDir, 'build-and-deploy.yml');
//             const workflowContent = `name: Build and Deploy Stats
// on:
//   push:
//     branches:
//       - main
//     paths:
//       - "stats/**"
// jobs:
//   build-and-deploy:
//     runs-on: ubuntu-latest
//     permissions:
//       pages: write
//       id-token: write
//       contents: write
//     environment:
//       name: github-pages
//     steps:
//       - name: Checkout Repository
//         uses: actions/checkout@v4
//       - name: Set up Node.js
//         uses: actions/setup-node@v3
//         with:
//           node-version: "18"
//       - name: Install Dependencies
//         run: cd stats && npm install
//       - name: Build Website
//         run: cd stats && npm run build
//       - name: Setup Pages
//         uses: actions/configure-pages@v4
//       - name: Upload artifact
//         uses: actions/upload-pages-artifact@v3
//         with:
//           path: stats/dist
//       - name: Deploy to GitHub Pages
//         id: deployment
//         uses: actions/deploy-pages@v4`;
    
//             await fs.promises.writeFile(workflowPath, workflowContent);
//             await this.git.add(workflowPath);
//             await this.git.commit('Add GitHub Actions workflow');
//             await this.git.push('origin', 'main');
//             this.outputChannel.appendLine('GitHub Actions workflow setup complete');
    
//             // Enable GitHub Pages programmatically
//             const token = this.githubService.token; // Ensure this method exists in your GitHubService
//             if (!token) {
//                 throw new Error('GitHub token is not set');
//             }
//             const owner = 'your-username'; // Replace with your repository owner
//             const repo = 'your-repo-name'; // Replace with your repository name
//             const branch = 'main';
//             const sourcePath = '/stats/dist'; // Adjust if your build output directory differs
    
//             const url = `https://api.github.com/repos/${owner}/${repo}/pages`;
//             const response = await fetch(url, {
//                 method: 'POST',
//                 headers: {
//                     'Authorization': `Bearer ${token}`,
//                     'Accept': 'application/vnd.github.v3+json',
//                     'Content-Type': 'application/json',
//                 },
//                 body: JSON.stringify({
//                     source: {
//                         branch: branch,
//                         path: sourcePath,
//                     },
//                 }),
//             });
    
//             if (!response.ok) {
//                 throw new Error(`Failed to enable GitHub Pages: ${response.statusText}`);
//             }
//             this.outputChannel.appendLine('GitHub Pages enabled successfully');
//         } catch (error) {
//             this.outputChannel.appendLine(`Error setting up GitHub Actions workflow - ${error}`);
//             this.outputChannel.appendLine('Continuing setup despite GitHub Actions failure');
//         }
//     }

    public async initializeRepo(remoteUrl: string, github: GitHubService): Promise<void> {
        this.githubService = github;

        return this.enqueueOperation(async () => {
            try {
                if (!(await this.validateWorkspace())) {
                    throw new Error('Workspace validation failed');
                }

                // Basic setup
                await this.ensureRepoSetup(remoteUrl);
                await this.setupGitIgnore();

                const changesDir = path.join(this.currentTrackingDir, 'changes');
                if (!fs.existsSync(changesDir)) {
                    await fs.promises.mkdir(changesDir, { recursive: true });
                    await fs.promises.writeFile(path.join(changesDir, '.gitkeep'), '');
                    await this.git.add('changes/.gitkeep');
                }

                await this.git.commit('syncforge: Initial commit');
                await this.git.push(['--set-upstream', 'origin', 'main']);
                this.outputChannel.appendLine('Syncforge: Initial push successful');

                // Additional setup after remote is established
                await this.initializeStatistics(true);
                // await this.setupGitHubWorkflow(); // Now optional due to error handling

                this.outputChannel.appendLine('Syncforge: Repo initialization complete');

            } catch (error: any) {
                this.outputChannel.appendLine(`Syncforge: Failed to initialize repository - ${error.message}`);
                throw error;
            }
        });
    }


    private async ensureGitInitialized(): Promise<void> {
        try {
            if (!this.git) {
                // Get Tracking Directory first
                await this.createTrackingDirectory();

                const options: Partial<SimpleGitOptions> = {
                    baseDir: this.currentTrackingDir,
                    binary: this.findGitExecutable(),
                    maxConcurrentProcesses: 1,
                };


                this.git = simpleGit(options);
                this.outputChannel.appendLine("syncforge: Git Initialized successfully!");
            }
        } catch (error: any) {
            this.outputChannel.appendLine(`Syncforge: Failed to initialize Git - ${error.message}`);

            throw error;
        }
    }

    // Helper method to ensure repository and remote are properly set up
    public async ensureRepoSetup(remoteUrl: string): Promise<void> {
        try {
            // Ensure Git is initialized
            await this.ensureGitInitialized();
            this.outputChannel.appendLine('Syncforge: Git initialization confirmed');

            const isRepo = await this.git.checkIsRepo();
            if (!isRepo) {
                await this.git.init();
                this.outputChannel.appendLine('Syncforge: Initialized new Git repository');
                await this.git.addConfig('user.name', 'syncforge', false, 'local');
                await this.git.addConfig('user.email', 'vatshivam49888@gmail.com', false, 'local');
                await this.git.checkoutLocalBranch('main');
                this.outputChannel.appendLine('Syncforge: Created main branch');
            } else {
                this.outputChannel.appendLine('Syncforge: Existing Git repository detected');
            }

            // Check and set remote
            const remotes = await this.git.getRemotes();
            this.outputChannel.appendLine(`Syncforge: Current remotes: ${JSON.stringify(remotes)}`);
            const hasOrigin = remotes.some((remote) => remote.name === 'origin');

            if (!hasOrigin) {
                await this.git.addRemote('origin', remoteUrl);
                this.outputChannel.appendLine(`Syncforge: Added remote origin ${remoteUrl.replace(/x-access-token:[^@]+@/, 'x-access-token:[hidden]@')}`);
            } else {
                const currentRemoteResult = await this.git.getConfig('remote.origin.url');
                const currentRemote = currentRemoteResult.value;
                
                // this.outputChannel.appendLine(`Syncforge: Current origin URL: ${currentRemote || 'none'}`);

                if (currentRemote !== remoteUrl && currentRemote !== null) {
                    await this.git.removeRemote('origin');
                    this.outputChannel.appendLine('Syncforge: Removed existing origin');
                    await this.git.addRemote('origin', remoteUrl);
                    this.outputChannel.appendLine(`Syncforge: Updated remote origin to ${remoteUrl.replace(/x-access-token:[^@]+@/, 'x-access-token:[hidden]@')}`);
                } else {
                    this.outputChannel.appendLine('Syncforge: Origin already matches expected URL or is unset');
                }
            }

            // Sync with remote
            try {
                await this.git.fetch('origin', 'main');
                this.outputChannel.appendLine('Syncforge: Fetched origin/main');
                const status = await this.git.status();
                if (status.current === 'main') {
                    await this.git.reset(['--hard', 'origin/main']);
                    this.outputChannel.appendLine('Syncforge: Reset local main to match origin/main');
                }
            } catch (fetchError: any) {
                this.outputChannel.appendLine(`Syncforge: Fetch failed (likely no remote branch yet) - ${fetchError.message}`);
                // If fetch fails (e.g., remote branch doesn’t exist), proceed without syncing
            }

            // Verify remote setup
            const verifiedRemotes = await this.git.remote(['-v']);
            this.outputChannel.appendLine(`Syncforge: Verified remotes: ${verifiedRemotes || 'none'}`);
            if (typeof verifiedRemotes === 'string' && !verifiedRemotes.includes('origin')) {
                throw new Error('Failed to verify origin remote after setup');
            } else if (!verifiedRemotes) {
                throw new Error('No remotes returned from git remote -v');
            }

            this.outputChannel.appendLine('Syncforge: Repo setup complete (no push attempted)');

        } catch (error: any) {
            this.outputChannel.appendLine(`Syncforge: Error ensuring repo setup - ${error.message}`);
            this.outputChannel.appendLine(`Syncforge: Stack trace - ${error.stack || 'No stack available'}`);
            throw error;
        }
    }

    private async updateStatsData(stats: any): Promise<void> {
        try {
          const statsDir = path.join(this.currentTrackingDir, 'stats');
          const dataDir = path.join(statsDir, 'data');
          await fs.promises.mkdir(dataDir, { recursive: true });
      
          // Update stats data in Data Dir
          const statsDataPath = path.join(dataDir, 'stats.json');
          await fs.promises.writeFile(statsDataPath, JSON.stringify(stats, null, 2));
      
          // Create package.json if it doesn't exist
          const packagePath = path.join(statsDir, 'package.json');
          if (!fs.existsSync(packagePath)) {
            const packageJson = {
              name: 'syncforge-stats',
              private: true,
              version: '0.0.0',
              type: 'module',
              scripts: {
                dev: 'vite',
                build: 'vite build',
                preview: 'vite preview',
              },
              dependencies: {
                '@types/react': '^18.2.55',
                '@types/react-dom': '^18.2.19',
                '@vitejs/plugin-react': '^4.2.1',
                react: '^18.2.0',
                'react-dom': '^18.2.0',
                recharts: '^2.12.0',
                vite: '^5.1.0',
              },
            };
            await fs.promises.writeFile(packagePath, JSON.stringify(packageJson, null, 2));
          }
      
          // Create vite.config.js if it doesn't exist
          const vitConfigPath = path.join(statsDir, 'vite.config.js');
          if (!fs.existsSync(vitConfigPath)) {
            const viteConfig = `
      import { defineConfig } from 'vite'
      import react from '@vitejs/plugin-react'
      
      export default defineConfig({
        plugins: [react()],
        base: '/code-tracking/stats/',
      })`;
            await fs.promises.writeFile(vitConfigPath, viteConfig);
          }
      
          // Create index.html if it doesn't exist
          const indexPath = path.join(statsDir, 'index.html');
          if (!fs.existsSync(indexPath)) {
            const indexHtml = `
      <!DOCTYPE html>
      <html lang="en">
        <head>
          <meta charset="UTF-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1.0" />
          <title>syncforge Statistics</title>
        </head>
        <body>
          <div id="root"></div>
          <script type="module" src="/src/main.tsx"></script>
        </body>
      </html>`;
            await fs.promises.writeFile(indexPath, indexHtml);
          }
      
          // Create main.tsx if it doesn't exist
          const srcDir = path.join(statsDir, 'src');
          await fs.promises.mkdir(srcDir, { recursive: true });
      
          const mainPath = path.join(srcDir, 'main.tsx');
          if (!fs.existsSync(mainPath)) {
            const mainTsx = `
      import React from 'react'
      import ReactDOM from 'react-dom/client'
      import CodingStatsDashboard from './components/CodingStatsDashboard'
      import './index.css'
      
      ReactDOM.createRoot(document.getElementById('root')!).render(
        <React.StrictMode>
          <CodingStatsDashboard />
        </React.StrictMode>,
      )`;
            await fs.promises.writeFile(mainPath, mainTsx);
          }
      
          // Create basic CSS
          const cssPath = path.join(srcDir, 'index.css');
          if (!fs.existsSync(cssPath)) {
            const css = `
      @tailwind base;
      @tailwind components;
      @tailwind utilities;`;
            await fs.promises.writeFile(cssPath, css);
          }
      
          // Create components directory and CodingStatsDashboard.tsx
          const componentsDir = path.join(srcDir, 'components');
          await fs.promises.mkdir(componentsDir, { recursive: true });
      
          const dashboardPath = path.join(componentsDir, 'CodingStatsDashboard.tsx');
          if (!fs.existsSync(dashboardPath)) {
            const dashboardContent = `
      import React from 'react';
      
      const CodingStatsDashboard: React.FC = () => {
        return (
          <div>
            <h1>syncforge Statistics Dashboard</h1>
            <p>Statistics will be displayed here.</p>
          </div>
        );
      };
      
      export default CodingStatsDashboard;`;
            await fs.promises.writeFile(dashboardPath, dashboardContent);
          }
      
          const uiDir = path.join(componentsDir, 'ui');
          await fs.promises.mkdir(uiDir, { recursive: true });
      
          // Add to git
          await this.git.add(statsDir);
          await this.git.commit('Syncforge: Update Statistics data and Website');
      
          const currentBranch = (await this.git.branch()).current;
          await this.git.push('origin', currentBranch);
      
          this.outputChannel.appendLine('Syncforge: Statistics data updated and pushed');
        } catch (error) {
          this.outputChannel.appendLine(`Syncforge: Error updating stats data - ${error}`);
          throw error;
        }
      }


    private async getUpdatedStats(): Promise<syncforgeStats> {
        const log = await this.git.log();
        const now = new Date();

        const stats: syncforgeStats = {
            totalTime: 0,
            filesModified: 0,
            totalCommits: log.total,
            linesChanged: 0,
            activityTimeline: [] as ActivityTimelineEntry[],
            timeDistribution: [] as TimeDistribution[],
            fileTypes: [] as FileTypeStats[],
        };


        // Initialize timeDistribution array with all hours
        for (let i = 0; i < 24; i++) {
            stats.timeDistribution.push({ hour: i, changes: 0 });
        }

        const timelineMap = new Map<string, ActivityTimelineEntry>();

        // Process Commits
        for (const commit of log.all) {
            const commitDate = new Date(commit.date);
            const hourOfDay = commitDate.getHours();

            // Update Time distribution
            stats.timeDistribution[hourOfDay].changes++;

            // Update Activity Timeline
            const dateKey = commitDate.toISOString().split('T')[0];           // Extract YYYY-MM-DD
            if (!timelineMap.has(dateKey)) {
                timelineMap.set(
                    dateKey,
                    { date: dateKey, commits: 0, filesChanged: 0 }
                );
            }

            const timelineEntry = timelineMap.get(dateKey)!;
            timelineEntry.commits++;


            // Estimates the Files changed from Commit Message
            const filesChanged = commit.message
                .split('\n')
                .filter(
                    (line) => line.trim().startsWith('-')
                )
                .length;

            timelineEntry.filesChanged += filesChanged || 1;
        }

        // Convert timeline map to array and sort by date
        stats.activityTimeline = Array.from(timelineMap.values())
            .sort(
                (a, b) => a.date.localeCompare(b.date)
            );

        // Calculate total modified files
        stats.filesModified = stats.activityTimeline.reduce(
            (total, entry) => total + entry.filesChanged,
            0                                                                       // An initial value (0) which acts as the starting value for the total sum.
        );


        // Estimate total time (30 minutes per commit as a rough estimate)
        stats.totalTime = Math.round((stats.totalCommits * 30) / 60); // Convert to hours

        // Calculate file types from recent commits
        const fileTypesMap = new Map<string, number>();
        for (const commit of log.all.slice(0, 100)) {
            // Look at last 100 commits
            const files = commit.message.match(/\.(ts|js|tsx|py|rs|jsx|css|html|md)x?/g) || [];

            for (const file of files) {
                const ext = file.replace('.', '').toLowerCase();
                fileTypesMap.set(ext, (fileTypesMap.get(ext) || 0) + 1);
            }
        }


        // Convert file types to array with percentages
        const totalFiles = Array.from(fileTypesMap.values()).reduce(
            (a, b) => a + b,
            0
        );

        stats.fileTypes = Array.from(fileTypesMap.entries()).map(
            ([name, count]) => ({
                name: name.toUpperCase(),
                count,
                percentage: Math.round((count / totalFiles) * 100),
            })
        );


        return stats;
    }


    private async verifyCommitTracking(message: string): Promise<void> {
        try {
            // Check if the commit was actually saved
            const log = await this.git.log({ maxCount: 1 });

            if (log.latest?.message !== message) {
                this.outputChannel.appendLine('Syncforge: Warning - Last commit message does not match expected message');
                this.outputChannel.appendLine(`Expected: ${message}`);
                this.outputChannel.appendLine(`Actual: ${log.latest?.message || 'No commit found'}`);
            } else {
                this.outputChannel.appendLine('Syncforge: Successfully verified commit was tracked');
            }
        } catch (error) {
            this.outputChannel.appendLine(`Syncforge: Error verifying commit - ${error}`);
        }
    }

    // This function formats a given date (Date object) into two different timestamp formats: Sortable timestamp (sortable) – Used for filenames or logging.
    // Readable timestamp (readable) – Used for commit messages or user-friendly displays.
    private formatTimestamp(date: Date): TimeStampFormat {
        const pad = (num: number): string => num.toString().padStart(2, '0');

        // Format time in 12-hour format with AM/PM
        const formatTime = (date: Date): string => {
            let hours = date.getHours();
            const minutes = date.getMinutes();
            const seconds = date.getSeconds();
            const ampm = hours >= 12 ? 'PM' : 'AM';

            // Convert to 12-hour format
            hours = hours % 12;
            hours = hours ? hours : 12; // the hour '0' should be '12'

            return `${pad(hours)}${pad(minutes)}-${pad(seconds)}-${ampm}`;
        };

        // Get local date components
        const year = date.getFullYear();
        const month = pad(date.getMonth() + 1);
        const day = pad(date.getDate());

        // Get timezone
        const timezone = date
            .toLocaleTimeString('en-us', { timeZoneName: 'short' })
            .split(' ')[2];

        // For file name (now includes AM/PM)
        const sortableTimestamp = `${year}-${month}-${day}-${formatTime(date)}`;

        // For commit message (human readable with timezone)
        const readableTimestamp = `${date.toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'long',
            day: 'numeric',
        })} at ${date.toLocaleTimeString('en-US', {
            hour: 'numeric',
            minute: '2-digit',
            second: '2-digit',
            hour12: true,
        })} ${timezone}`;

        return {
            sortable: sortableTimestamp,
            readable: readableTimestamp,
        };
    }

    private async withProcessLimit<T>(operation: () => Promise<T>): Promise<T> {
        while (this.activeProcesses >= GitService.PROCESS_LIMIT) {
            await new Promise((resolve) => globalThis.setTimeout(resolve, 100));
        }

        this.activeProcesses++;
        try {
            return await operation();
        } finally {
            this.activeProcesses--;
        }
    }

    private async withRetry<T>(operation: () => Promise<T>, retries = GitService.MAX_RETRIES): Promise<T> {
        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                return await this.withProcessLimit(operation);
            } catch (error: any) {
                if (error.message?.includes('EAGAIN') && attempt < retries) {
                    this.outputChannel.appendLine(`Syncforge: Git process limit reached, retrying (${attempt}/${retries})...`);
                    await new Promise((resolve) =>
                        globalThis.setTimeout(resolve, GitService.RETRY_DELAY * attempt)
                    );
                    continue;
                }
                throw error;
            }
        }
        throw new Error('Maximum retry attempts reached');
    }

    public async commitAndPush(message: string): Promise<void> {
        return this.enqueueOperation(async () => {
            try {
                if (!this.git) {
                    throw new Error('Git not initialized');
                }

                const changesDir = path.join(this.currentTrackingDir, 'changes');
                if (!fs.existsSync(changesDir)) {
                    await fs.promises.mkdir(changesDir, { recursive: true });
                }

                const codeBlockRegex = /```\n(.*?):\n([\s\S]*?)```/g;
                let match;
                const timestamp = this.formatTimestamp(new Date());
                const filesToAdd: string[] = [];

                while ((match = codeBlockRegex.exec(message)) !== null) {
                    const [_, filename, code] = match;
                    const cleanFilename = filename.trim();
                    const extension = path.extname(cleanFilename);
                    const baseNameWithoutExt = path.basename(cleanFilename, extension);
                    const timestampedFilename = `${timestamp.sortable}-${baseNameWithoutExt}${extension}`;
                    const filePath = path.join(changesDir, timestampedFilename);

                    await fs.promises.writeFile(filePath, code.trim());
                    filesToAdd.push(filePath);
                }

                const updatedMessage = message.replace(
                    /syncforge Update - [0-9T:.-Z]+/,
                    `syncforge Update - ${timestamp.readable}`
                );

                this.outputChannel.appendLine(`Current Tracking Directory: ${this.currentTrackingDir}`);
                this.emitSafe('operation:start', 'commitAndPush');

                await this.withRetry(async () => {
                    const branches = await this.git.branch();
                    const currentBranch = branches.current;

                    for (const file of filesToAdd) {
                        await this.git.add(file);
                    }

                    await this.git.commit(updatedMessage);
                    this.emitSafe('commit', updatedMessage);

                    // Sync with remote before pushing
                    try {
                        await this.git.fetch('origin', 'main');
                        await this.git.merge(['origin/main']);
                        this.outputChannel.appendLine('Syncforge: Merged origin/main');
                    } catch (fetchError: any) {
                        this.outputChannel.appendLine(`Syncforge: Fetch/merge skipped (likely no remote branch yet) - ${fetchError.message}`);
                    }

                    try {
                        await this.git.push(['origin', currentBranch]);
                        this.emitSafe('push', currentBranch);
                    } catch (pushError: any) {
                        this.outputChannel.appendLine(`Syncforge: Push failed - ${pushError.message}`);
                        if (pushError.message.includes('rejected') || pushError.message.includes('stale info')) {
                            await this.git.fetch('origin', 'main');
                            await this.git.rebase(['origin/main']);
                            await this.git.push(['origin', currentBranch]);
                            this.outputChannel.appendLine('Syncforge: Rebased and pushed successfully');
                        } else {
                            throw pushError;
                        }
                    }
                });

                this.emitSafe('operation:end', 'commitAndPush');
                const stats = await this.getUpdatedStats();
                await this.updateStatsData(stats);

                this.outputChannel.appendLine('Syncforge: Commit and push completed');

            } catch (error: any) {
                this.outputChannel.appendLine(`Syncforge: Git commit failed - ${error.message}`);
                this.emitSafe('error', error);
                throw error;
            }
        });
    }

    public async recordChanges(message: string, changedFiles: string[]): Promise<void> {
        if (!this.currentTrackingDir) {
            await this.initializeTracking();
        }

        return this.enqueueOperation(async () => {
            try {
                // Create a change record
                const change = {
                    timeStamp: new Date().toISOString(),
                    files: changedFiles,
                    summary: message,
                };

                // Update metadata with new change
                const metadataPath = path.join(
                    this.currentTrackingDir,
                    'tracking.json'
                );
                const metadata: TrackingMetadata = JSON.parse(
                    await fs.promises.readFile(metadataPath, 'utf8')
                );

                metadata.changes = metadata.changes || [];
                metadata.changes.push(change);
                metadata.lastSync = change.timeStamp;

                // Save updated metadata
                await fs.promises.writeFile(
                    metadataPath,
                    JSON.stringify(metadata, null, 2)
                );

                // Commit change to tracking repository
                if (this.git) {
                    await this.git.add('.');
                    await this.git.commit(message);
                }

                this.outputChannel.appendLine(
                    'syncforge: Changes recorded successfully'
                );
            } catch (error: any) {
                this.outputChannel.appendLine(
                    `syncforge: Failed to record changes - ${error.message}`
                );
                throw error;
            }
        });
    }

    public async commitChanges(message: string, changes: any[]): Promise<void> {
        return this.enqueueOperation(async () => {
            try {
                if (!this.git) {
                    throw new Error('Tracking repository not initialized');
                }

                // Create change snapshot
                const snapshotPath = path.join(this.currentTrackingDir, 'changes');
                if (!fs.existsSync(snapshotPath)) {
                    await fs.promises.mkdir(snapshotPath, { recursive: true });
                }

                // Save change data
                const timeStamp = new Date().toISOString().replace(/[:.]/g, '-');
                const snapshotFile = path.join(
                    snapshotPath,
                    `changes-${timeStamp}.json`
                );
                await fs.promises.writeFile(
                    snapshotFile,
                    JSON.stringify({ message, changes }, null, 2)
                );

                // Update tracking metadata
                await this.updateTrackingMetadata({
                    lastCommit: {
                        message,
                        timeStamp,
                        changeCount: changes.length,
                    },
                });

                // Commit to tracking repository
                await this.git.add('.');
                await this.git.commit(message);

                this.outputChannel.appendLine(
                    'syncforge: Changes committed to tracking repository'
                );
            } catch (error: any) {
                this.outputChannel.appendLine(
                    `syncforge: Commit failed - ${error.message}`
                );
                throw error;
            }
        });
    }

    // Helper method to check if we have any listeners for an event
    public hasListeners(event: keyof GitServiceEvents): boolean {
        return this.listenerCount(event) > 0;
    }

    public cleanUp(): void {
        this.activeProcesses = 0;
        this.processQueue = Promise.resolve();
    }

    public dispose(): void {
        this.removeAllListeners();
        this.operationQueue = Promise.resolve();
        this.cleanUp();
    }
}
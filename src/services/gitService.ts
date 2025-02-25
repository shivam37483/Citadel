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

interface AnthraxStats {
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


    private setupDefaultErrorHandler() {
        if (this.listenerCount('error') == 0) {             // Returns the number of listeners listening for the event named eventName
            this.on('error', (error: Error) => {
                this.outputChannel.appendLine(`Anthrax: Unhandled Git error - ${error.message}`);
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
        this.baseTrackingDir = path.join(homeDir, '.anthrax');


        // Ensuring base Directory exists
        if (!fs.existsSync(this.baseTrackingDir)) {
            fs.mkdirSync(this.baseTrackingDir, { recursive: true });
        }
    }

    // Type - safe Event Emmiter methods. It extends keyof GitServiceEvents, meaning E must be a key of the GitServiceEvents type. This ensures that event can only be a valid event name defined in GitServiceEvents.
    // listener: The callback function that will be executed when the event occurs. GitServiceEvents[E] ensures that the listener matches the expected function signature for the given event.
    public on<E extends keyof GitServiceEvents>(event: E, listener: GitServiceEvents[E]): this {
        if (event === 'error' && this.listenerCount('error') >= GitService.MAX_LISTENERS - 1) {
            this.outputChannel.appendLine('Anthrax: Warning - Too many error listeners');
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
                this.outputChannel.appendLine(`Anthrax: No listerners for event - ${String(event)}`);

                return false;
            }

            return super.emit(event, ...args);
        } catch (error) {
            this.outputChannel.appendLine(`Anthrax: Error emitting event ${String(event)}`);

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
                    `Anthrax: Linux permissions check failed - ${error.message}`
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

            if (major < 2 || (major === 2 && minor < 140)) {
                throw new Error(
                    `Git version ${version} is not supported. Please upgrade to 2.30.0 or later.`
                );
            }

            this.outputChannel.appendLine(
                `Anthrax: Git version ${version} verified`
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
                        this.outputChannel.appendLine(`Anthrax: Found Git in PATH at ${gitExePath}`);

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
                        this.outputChannel.appendLine(`Anthrax: Found Git at ${gitPath}`);
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
                        this.outputChannel.appendLine(`Anthrax: Found Git using 'where' command at ${gitPathFromWhere}`);

                        return gitPathFromWhere;
                    }

                } catch (error) {
                    this.outputChannel.appendLine('Anthrax: Git not found in PATH');
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
                                    `Anthrax: Found Git using '${method}' at ${gitPath}`
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
                                `Anthrax: Found Git at ${gitPath}`
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
                `Anthrax: Error finding Git executable - ${error}`
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

            this.outputChannel.appendLine(`Anthrax: Tracking directory initialized at ${this.currentTrackingDir}`);

        } catch (error: unknown) {
            const errorMessage =
                error instanceof Error ? error.message : String(error);
            this.outputChannel.appendLine(`Anthrax: Tracking initialization failed - ${errorMessage}`);

            throw error;
        }
    }


    private async validateWorkspace(): Promise<boolean> {
        const workspaceFolders = vscode.workspace.workspaceFolders;

        if (!workspaceFolders || workspaceFolders.length === 0) {
            this.outputChannel.appendLine('Anthrax: No workspace folder is open');
            return false;
        }

        // Only validate Git is installed, don't check workspace Git status
        try {
            await this.checkGitEnvironment();
            return true;
        } catch (error) {
            this.outputChannel.appendLine(
                `Anthrax: Git validation failed - ${error}`
            );
            return false;
        }
    }


    private async createTrackingDirectory(): Promise<void> {
        if (!this.currentTrackingDir) {
            const homeDir = process.env.HOME || process.env.USERPROFILE;
            if (!homeDir) {
                throw new Error('Unable to determine home directory for Anthrax');
            }

            // Create a unique tracking directory under .Anthrax in home directory
            const workspaceId = Buffer.from(
                vscode.workspace.workspaceFolders![0].uri.fsPath
            )
                .toString('base64')
                .replace(/[/+=]/g, '_');

            this.currentTrackingDir = path.join(
                homeDir,
                '.Anthrax',
                'tracking',
                workspaceId
            );

            if (!fs.existsSync(this.currentTrackingDir)) {
                await fs.promises.mkdir(this.currentTrackingDir, { recursive: true });
            }
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
                    `Anthrax: Set upstream tracking for ${currentBranch}`
                );
            } catch (error) {
                this.outputChannel.appendLine(
                    `Anthrax: Failed to set upstream - ${error}`
                );
                throw error;
            }
        } catch (error) {
            this.outputChannel.appendLine(
                `Anthrax: Error in setupRemoteTracking - ${error}`
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
                'Anthrax: Failed to update tracking metadata'
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
                    this.outputChannel.appendLine(`Anthrax: Operation failed: ${error}`);
                    throw error;
                }
            );

        return this.operationQueue;
    }


    private async setupGitIgnore(): Promise<void> {
        const gitignorePath = path.join(this.currentTrackingDir, '.gitignore');
        const gitignoreContent = `
# Anthrax - Only track specific directories
/*

# Allow Anthrax directories
!/stats/
!/changes/
!/.gitignore
!/.gitkeep

# Ensure no workspace files are tracked
*.workspace
*.code-workspace
.vscode/
node_modules/`;

        await fs.promises.writeFile(gitignorePath, gitignoreContent);
        await this.git.add('.gitignore');
        await this.git.commit('Anthrax: Added gitignore to protect workspace');
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
        <title>Anthrax Statistics</title>
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
                    '// Anthrax Dashboard initialization'
                );
            }

            // Initialize empty stats data
            const initialStats: AnthraxStats = {
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
                await this.git.commit('Anthrax: Initialize statistics tracking');

                // Push changes only if we have a remote set up
                try {
                    const currentBranch = (await this.git.branch()).current;
                    await this.git.push('origin', currentBranch);
                } catch (pushError) {
                    // Log push error but don't fail initialization
                    this.outputChannel.appendLine(`Anthrax: Warning - Could not push initial stats: ${pushError}`);
                }
            }

            this.hasInitializedStats = true;
            this.outputChannel.appendLine('Anthrax: Statistics tracking initialized successfully');

        } catch (error) {
            this.outputChannel.appendLine(`Anthrax: Failed to initialize statistics - ${error}`);
            // Don't throw the error - allow the app to continue without stats
            this.hasInitializedStats = false;
        }
    }


    private async setupGitHubWorkflow(): Promise<void> {
        try {
            // Creating .github/workflows dir in tracking repo
            const workflowsDir = path.join(this.currentTrackingDir, '.github', 'workflows');

            await fs.promises.mkdir(workflowsDir, { recursive: true });


            // Create build-and-deploy yaml
            const workflowPath = path.join(workflowsDir, 'build-and-deploy.yml');

            // The workflow runs when a push occurs to the main branch. It only triggers when files in stats/ or stats-data/ are modified. Ensures stats website updates automatically after a push.
            const workflowContent = `name: Build and Deploy Stats

  on:
    push:
      branches: [ main ]
      paths:
        - 'stats/**'
        - 'stats-data/**'
  
  jobs:
    build-and-deploy:
      runs-on: ubuntu-latest
      permissions:
        pages: write
        id-token: write
      environment:
        name: github-pages
        url: \${{ steps.deployment.outputs.page_url }}
      steps:
        - uses: actions/checkout@v3
        
        - name: Set up Node.js
          uses: actions/setup-node@v3
          with:
            node-version: '18'
            cache: 'npm'
            
        - name: Install Dependencies
          run: |
            cd stats
            npm install
            
        - name: Build Website
          run: |
            cd stats
            npm run build
            
        - name: Setup Pages
          uses: actions/configure-pages@v4
          
        - name: Upload artifact
          uses: actions/upload-pages-artifact@v3
          with:
            path: stats/dist
            
        - name: Deploy to GitHub Pages
          id: deployment
          uses: actions/deploy-pages@v4`;


            await fs.promises.writeFile(workflowPath, workflowContent);

            // Add and commit the workflow file
            await this.git.add(workflowPath);
            await this.git.commit('Anthrax: Add GitHub Actions workflow for stats website');

            const currentBranch = (await this.git.branch()).current;
            await this.git.push('origin', currentBranch);

            this.outputChannel.appendLine('Anthrax: GitHub Actions workflow setup complete');

        } catch (error) {
            this.outputChannel.appendLine(`Anthrax: Error setting up GitHub Actions workflow - ${error}`);
            throw error;
        }
    }


    public async initializeRepo(remoteUrl: string): Promise<void> {
        return this.enqueueOperation(
            async () => {
                try {
                    if (!(await this.validateWorkspace())) {
                        return;
                    }

                    // Initialize Git first
                    await this.ensureGitInitialized();
                    await this.setupGitIgnore();
                    await this.createTrackingDirectory();
                    await this.setupGitHubWorkflow();


                    const changesDir = path.join(this.currentTrackingDir, 'changes');
                    if (!fs.existsSync(changesDir)) {
                        await fs.promises.mkdir(changesDir, { recursive: true });
                    }


                    // Create a .gitkeep to ensure changes in Directory are tracked
                    const gitkeepPath = path.join(changesDir, '.gitkeep');
                    if (!fs.existsSync(gitkeepPath)) {
                        await fs.promises.writeFile(gitkeepPath, '');
                    }


                    const gitignorePath = path.join(this.currentTrackingDir, '.gitignore');
                    const gitignoreContent = `
    # Anthrax - Ignore system files only
    .DS_Store
    node_modules/
    .vscode/
    *.log
    
    # Ensure changes directory is tracked
    !changes/
    !changes/*
    `;

                    await fs.promises.writeFile(gitignorePath, gitignoreContent);

                    const options: Partial<SimpleGitOptions> = {
                        baseDir: this.currentTrackingDir,
                        binary: this.findGitExecutable(),
                        maxConcurrentProcesses: 1,
                    }

                    this.git = simpleGit(options);
                    const isRepo = await this.git.checkIsRepo();                    // Validates that the current working directory is a valid git repo path.

                    if (!isRepo) {
                        await this.git.init();                                      // Initialize a git Repo
                        await this.git.addConfig(
                            'user.name',                                            // Adding user name and email for git intialization
                            'Anthrax',
                            false,
                            'local');

                        await this.git.addConfig(
                            'user.email',
                            'vatshivam49888@gmail.com',
                            false,
                            'local',
                        );

                        await this.git.add(['.gitignore', 'changes/.gitkeep']);
                        await this.git.commit('Anthrax: Initializing tracking Repo');


                        // Excplicitly create and checkout main branch
                        await this.git.raw(['branch', '-M', 'main']);

                    };


                    // Check if remote exists
                    const remotes = await this.git.getRemotes();
                    const hasOrigin = remotes.some(               // Determines whether the specified callback function returns true for any element of an array.
                        (remoteName) => remoteName.name === 'origin'
                    );


                    if (!hasOrigin) {
                        await this.git.addRemote('origin', remoteUrl);
                        this.outputChannel.appendLine(`Anthrax: Added Remote origin: ${remoteUrl}`);
                    } else {
                        await this.git.remote(['set-url', 'origin', remoteUrl]);
                        this.outputChannel.appendLine(`Updated remote origin to: ${remoteUrl}`);
                    }



                    // Ensure we are on main branch before setting up Tracking
                    const branches = await this.git.branch();              // List all branches
                    if (!branches.current || branches.current != 'main') {
                        await this.git.checkout('main');
                    }


                    // Set-up Remote Tracking
                    await this.setupRemoteTracking();
                    await this.initializeStatistics(true);

                    this.outputChannel.appendLine('AnthraxL Repo intialization complete');

                } catch (error: any) {
                    this.outputChannel.appendLine(`Anthrax: Failed to initialize repository - ${error.message}`);

                    throw error;
                }
            }
        );
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
                this.outputChannel.appendLine("Anthrax: Git Initialized successfully!");
            }
        } catch (error: any) {
            this.outputChannel.appendLine(
                `Anthrax: Failed to initialize Git - ${error.message}`
            );
            throw error;
        }
    }

    // Helper method to ensure repository and remote are properly set up
    public async ensureRepoSetup(remoteUrl: string): Promise<void> {
        try {
            // Initialize Git first
            await this.ensureGitInitialized();

            const isRepo = await this.git.checkIsRepo();
            if (!isRepo) {
                await this.initializeRepo(remoteUrl);
                return;
            }

            // Check remote
            const remotes = await this.git.getRemotes();
            const hasOrigin = remotes.some((remote) => remote.name === 'origin');

            if (!hasOrigin) {
                await this.git.addRemote('origin', remoteUrl);
                this.outputChannel.appendLine(`Anthrax: Added remote origin ${remoteUrl}`);
            } else {
                // Update existing remote URL
                await this.git.remote(['set-url', 'origin', remoteUrl]);
                this.outputChannel.appendLine(`Anthrax: Updated remote origin to ${remoteUrl}`);
            }
            await this.initializeStatistics(false);

            // Ensure we have the correct tracking branch
            try {
                const branches = await this.git.branch();
                await this.git.checkout('main');
                await this.git.push(['--set-upstream', 'origin', 'main']);
            } catch (error: any) {
                this.outputChannel.appendLine(`Anthrax: Error setting up tracking branch - ${error.message}`);
                // Continue even if push fails - we'll retry on next operation
            }
        } catch (error: any) {
            this.outputChannel.appendLine(
                `Anthrax: Error ensuring repo setup - ${error.message}`
            );
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


            // Create package.json if it doesnt exist
            const packagePath = path.join(statsDir, 'package.json');
            if (!fs.existsSync(packagePath)) {
                const packageJson = {
                    name: 'anthrax-stats',
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


            // Create vite.config.js if it doesnt exist
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
      <title>Anthrax Statistics</title>
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


            const componentsDir = path.join(srcDir, 'components');
            await fs.promises.mkdir(componentsDir, { recursive: true });

            const uiDir = path.join(componentsDir, 'ui');
            await fs.promises.mkdir(uiDir, { recursive: true });


            // Add to git
            await this.git.add(statsDir);
            await this.git.commit('Anthrax: Update Statistics data and Website');

            const currentBranch = (await this.git.branch()).current;
            await this.git.push('origin', currentBranch);

            this.outputChannel.appendLine('Anthrax: Statistics data updated and pushed');


        } catch (error) {
            this.outputChannel.appendLine(`Anthrax: Error updating stats data - ${error}`);

            throw error;
        }
    }


    private async getUpdatedStats(): Promise<AnthraxStats> {
        const log = await this.git.log();
        const now = new Date();

        const stats: AnthraxStats = {
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
                this.outputChannel.appendLine('Anthrax: Warning - Last commit message does not match expected message');
                this.outputChannel.appendLine(`Expected: ${message}`);
                this.outputChannel.appendLine(`Actual: ${log.latest?.message || 'No commit found'}`);
            } else {
                this.outputChannel.appendLine('Anthrax: Successfully verified commit was tracked');
            }
        } catch (error) {
            this.outputChannel.appendLine(`Anthrax: Error verifying commit - ${error}`);
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
                    this.outputChannel.appendLine(`Anthrax: Git process limit reached, retrying (${attempt}/${retries})...`);
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

                // Create a changes directory if it doesn't exist
                const changesDir = path.join(this.currentTrackingDir, 'changes');
                if (!fs.existsSync(changesDir)) {
                    await fs.promises.mkdir(changesDir, { recursive: true });
                }

                // Extract file content from the commit message
                const codeBlockRegex = /```\n(.*?):\n([\s\S]*?)```/g;
                let match;
                const timestamp = this.formatTimestamp(new Date());
                const filesToAdd: string[] = [];

                while ((match = codeBlockRegex.exec(message)) !== null) {
                    const [_, filename, code] = match;
                    const cleanFilename = filename.trim();
                    const extension = path.extname(cleanFilename);
                    const baseNameWithoutExt = path.basename(cleanFilename, extension);

                    // Create filename with timestamp: 2025-02-15-1200-00-AM-original_name.ts
                    const timestampedFilename = `${timestamp.sortable}-${baseNameWithoutExt}${extension}`;
                    const filePath = path.join(changesDir, timestampedFilename);

                    // Write the actual code file
                    await fs.promises.writeFile(filePath, code.trim());
                    filesToAdd.push(filePath);
                }

                // Update the commit message to include local timezone
                const updatedMessage = message.replace(
                    /Anthrax Update - [0-9T:.-Z]+/,
                    `Anthrax Update - ${timestamp.readable}`
                );

                this.emitSafe('operation:start', 'commitAndPush');

                await this.withRetry(async () => {
                    const branches = await this.git.branch();
                    const currentBranch = branches.current;

                    // Stage only the new code files
                    for (const file of filesToAdd) {
                        await this.git.add(file);
                    }

                    // Commit with the enhanced message
                    await this.git.commit(updatedMessage);
                    this.emitSafe('commit', updatedMessage);

                    try {
                        await this.git.push([
                            'origin',
                            currentBranch,
                            '--force-with-lease',
                        ]);
                        this.emitSafe('push', currentBranch);
                    } catch (pushError: any) {
                        if (pushError.message.includes('no upstream branch')) {
                            await this.setupRemoteTracking();
                            await this.git.push([
                                'origin',
                                currentBranch,
                                '--force-with-lease',
                            ]);
                        } else {
                            throw pushError;
                        }
                    }
                });

                this.emitSafe('operation:end', 'commitAndPush');
                const stats = await this.getUpdatedStats();
                await this.updateStatsData(stats);
            } catch (error: any) {
                this.outputChannel.appendLine(
                    `Anthrax: Git commit failed - ${error.message}`
                );
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
                    'Anthrax: Changes recorded successfully'
                );
            } catch (error: any) {
                this.outputChannel.appendLine(
                    `Anthrax: Failed to record changes - ${error.message}`
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
                    'Anthrax: Changes committed to tracking repository'
                );
            } catch (error: any) {
                this.outputChannel.appendLine(
                    `Anthrax: Commit failed - ${error.message}`
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

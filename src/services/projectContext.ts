// src/services/projectContext.ts
import * as vscode from 'vscode';
import { Change } from './tracker';
import * as path from 'path';

interface GitCommit {
    hash: string;
    message: string;
    commitDate: Date;
    files: { uri: vscode.Uri }[];
}

interface CommitHistory {
    timeStamp: number;
    summary: string;
    files: string[];
    hash?: string;
}

interface ProjectStats {
    mostChangedFiles: Map<string, number>;
    recentMilestones: string[];
    activeBranch: string;
    lastCommitTime: Date;
}

export class ProjectContext {
    private channel: vscode.OutputChannel;
    extensionContext: vscode.ExtensionContext;

    private commitHistory: CommitHistory[] = [];

    private projectStats: ProjectStats = {
        mostChangedFiles: new Map(),
        recentMilestones: [],
        activeBranch: '',
        lastCommitTime: new Date(),
    };

    constructor(channel: vscode.OutputChannel, extensionContext: vscode.ExtensionContext) {
        this.channel = channel;
        this.extensionContext = extensionContext;

        this.loadContext();
    }


    async loadContext() {
        try {
            await this.loadGitHistory();
            await this.updateProjectStats();

            this.channel.appendLine('Anthrax: Loaded Project Context');

        } catch (error) {
            this.channel.appendLine(`Anthrax: Error loading context: ${error}`);
        }
    }

    // Assign the loaded Git history to commitHistory pvt class variable
    private async loadGitHistory() {
        try {
            const gitExt = vscode.extensions.getExtension('vscode.git');
            if (gitExt) {
                const git = gitExt.exports.getAPI(1);
                if (git.repositories.length > 0) {
                    const repo = git.repositories[0];
                    const commits = (await repo.log({ maxEntries: 50 })) as GitCommit[];

                    this.commitHistory = commits.map(
                        (commit: GitCommit) => ({
                            timeStamp: commit.commitDate.getTime(),
                            summary: commit.message,
                            files: commit.files?.map(
                                (f) => vscode.workspace.asRelativePath(f.uri)
                            ) || [],
                            hash: commit.hash,
                        })
                    );
                }
            }
        } catch (error) {
            this.channel.appendLine(`Anthax: Error loading git history: ${error}`);
        }
    }


    // Populate the pvt class var - projectStats (Sorted freq, current git branch)
    private async updateProjectStats() {
        try {
            const stats = new Map<string, number>();

            // Update File change frequency from git history
            this.commitHistory.forEach(
                (commit) => {
                    commit.files.forEach(
                        (f) => {
                            if (this.shouldTrackFile(f)) {
                                const count = stats.get(f) || 0;

                                stats.set(f, count + 1);
                            }
                        }
                    );
                }
            );


            // Sort by Freq.
            const sortedFiles = new Map(
                [...stats.entries()].sort(
                    (a, b) => a[1] - b[1]
                ).slice(0, 10)
            );


            // Get git branch
            let currentBranch = '';
            try {
                const gitExt = vscode.extensions.getExtension('vscode-git');
                if (gitExt) {
                    const git = gitExt.exports.getAPI(1);

                    if (git.repositories.length > 0) {
                        currentBranch = git.repositories[0].state.HEAD?.name || '';
                    }
                }
            } catch (error) {
                this.channel.appendLine(`Anthrax: Error getting git branch: ${error}`);
            }


            this.projectStats = {
                mostChangedFiles: sortedFiles,
                recentMilestones: [],
                activeBranch: currentBranch,
                lastCommitTime: new Date(
                    this.commitHistory[0]?.timeStamp || Date.now()
                ),
            };

        } catch (error) {
            this.channel.appendLine(`Anthrax: Error updating project stats: ${error}`);
        }
    }


    // List of file etension that should and shouldn't be tracked 
    public shouldTrackFile(filePath: string): boolean {
        // Ignore specific patterns
        const ignorePatterns = [
            'node_modules',
            '.git',
            '.DS_Store',
            'dist',
            'out',
            'build',
            '.vscode',
        ];

        // Get file extension
        const fileExt = path.extname(filePath).toLowerCase().slice(1);

        // Track only specific file types
        const trackedExtensions = [
            'ts',
            'js',
            'py',
            'java',
            'c',
            'cpp',
            'h',
            'hpp',
            'css',
            'scss',
            'html',
            'jsx',
            'tsx',
            'vue',
            'php',
            'rb',
            'go',
            'rs',
            'swift',
            'md',
            'json',
            'yml',
            'yaml',
        ];

        return (
            !ignorePatterns.some((pattern) => filePath.includes(pattern)) &&
            Boolean(fileExt) &&
            trackedExtensions.includes(fileExt)
        );
    }

    public async addCommit(summary: string, changes: Change[]) {
        try {
            const trackedFiles = changes
                .map((change) => vscode.workspace.asRelativePath(change.uri))
                .filter((filePath) => this.shouldTrackFile(filePath));

            // eslint-disable-next-line no-unused-vars
            const commit: CommitHistory = {
                timeStamp: Date.now(),
                summary: summary,
                files: trackedFiles,
            };

            await this.loadGitHistory(); // Refresh Git history
            await this.updateProjectStats();
        } catch (error) {
            this.channel.appendLine(`Anthrax: Error adding commit: ${error}`);
        }
    }
}
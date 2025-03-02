// src/services/tracker.ts
import * as vscode from 'vscode';
import { EventEmitter } from 'events';
import { minimatch } from 'minimatch';
import { OutputChannel } from 'vscode';
import * as path from 'path';

export interface Change {
    uri: vscode.Uri;
    timeStamp: Date;
    type: 'changed' | 'added' | 'deleted';
}

export class Tracker extends EventEmitter {
    private channel: OutputChannel;
    private trackingDir: string;

    private excludePatterns: string[] = [];

    private watcher!: vscode.FileSystemWatcher;

    private isInitialized: boolean = false;

    private changes: Map<string, Change> = new Map();


    constructor(channel: OutputChannel, trackingDir: string) {
        super();

        this.channel = channel;
        this.trackingDir = trackingDir;
        this.initialize()
    }

    private async initialize(): Promise<void> {
        try {
            // Wait for workspace to be fully loaded
            if (!vscode.workspace.workspaceFolders?.length) {
                this.channel.appendLine('Anthrax: Waiting for workspace to load...');

                const disposable = vscode.workspace.onDidChangeWorkspaceFolders(
                    () => {
                        if (vscode.workspace.workspaceFolders?.length) {
                            this.initializeWatcher();
                            disposable.dispose();
                        }
                    }
                );
            } else {
                await this.initializeWatcher();
            }
        } catch (error) {
            this.channel.appendLine(`Anthrax: Initialization error - ${error}`);
        }
    }


    private async initializeWatcher() {
        try {
            const config = vscode.workspace.getConfiguration('anthrax');
            this.excludePatterns = config.get<string[]>('exclude') || [];

            // Log current workspace state
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders || workspaceFolders.length === 0) {
                this.channel.appendLine('Anthrax: No workspace folder found');
                return;
            }

            const workspaceFolder = workspaceFolders[0];
            this.channel.appendLine(`Anthrax: Initializing watcher for workspace: ${workspaceFolder.uri.fsPath}`);

            // Create a Watcher file for Specific global pattern for code files
            const filePattern = new vscode.RelativePattern(
                workspaceFolder,
                '**/*.{ts,js,py,java,c,cpp,h,hpp,css,scss,html,jsx,tsx,vue,php,rb,go,rs,swift,md,json,yml,yaml}'
            );


            // Dispose existing watcher if it exists
            if (this.watcher) {
                this.watcher.dispose();
            }

            this.watcher = vscode.workspace.createFileSystemWatcher(
                filePattern,
                false, // Don't ignore creates
                false, // Don't ignore changes
                false // Don't ignore deletes
            );


            // Set up event handlers with logging
            this.watcher.onDidChange(
                (uri) => {
                    this.channel.appendLine(`Anthrax: Change detected in file: ${uri.fsPath}`);

                    this.handleChange(uri, 'changed');
                }
            );


            this.watcher.onDidCreate(
                (uri) => {
                    this.channel.appendLine(`Anthrax: New file Created: ${uri.fsPath}`);

                    this.handleChange(uri, 'added');
                }
            );


            this.watcher.onDidDelete(
                (uri) => {
                    this.channel.appendLine(`Anthrax: File Deleted: ${uri.fsPath}`);

                    this.handleChange(uri, 'deleted');
                }
            );


            // Verify the watcher is active
            this.isInitialized = true;
            this.channel.appendLine('Anthrax: File system watcher successfully initialized');


            // Log intial workspace scan
            const files = await vscode.workspace.findFiles(
                '**/*',
                '**/node_modules/**'
            );
            this.channel.appendLine(`Anthrax: Found ${files.length} files in workspace`);

        } catch (error) {
            this.channel.appendLine(`Anthrax: Failed to initialize watcher - ${error}`);

            this.isInitialized = false;

        }
    }

    private handleChange(uri: vscode.Uri, type: 'added' | 'changed' | 'deleted') {
        try {
            if (!this.isInitialized) {
                this.channel.appendLine('Anthrax: Watcher not initialized, reinitializing...');
                this.initialize();

                return;
            }

            // For skipping files in Tracking Dir, validating extensions and removing exclusions
            if (!this.shouldTrackFile(uri.fsPath)) {
                return;
            }

            // Check if this is a meaningful change
            const existingChange = this.changes.get(uri.fsPath);                    // Pulling the corresponding value for this uri (key: fsPath)
            if (existingChange) {
                // Comparing existing value with the one provided in the function parameter
                if (existingChange.type === 'deleted' && type === 'added') {
                    type = 'added';
                } else if (existingChange.type === 'added' && type === 'changed') {
                    type = 'added';
                }
            }


            // Update or add change
            const change: Change = {
                uri,
                timeStamp: new Date(),
                type,
            };


            // Setting the Private variable of the class to the above assigned value to create a new entry
            this.changes.set(uri.fsPath, change);

            this.emit('change', change);

            // Log the tracked change
            this.channel.appendLine(`Anthrax: Successfully tracked ${type} in ${vscode.workspace.asRelativePath(uri)}`);
            this.channel.appendLine(`Anthrax: Current number of tracked changes: ${this.changes.size}`);

        } catch (error) {
            this.channel.appendLine(`Anthrax: Error handling file change: ${error}`);
        }
    }


    private shouldTrackFile(filePath: string): boolean {
        try {
            // Log the file being Checked
            this.channel.appendLine(`Anthrax: Checking file: ${filePath}`);

            // Skip the files in Tracking Dir
            if (filePath.includes(this.trackingDir)) {
                this.channel.appendLine(`Anthrax: Skipping file in tracking directory: ${filePath}`);

                return false;
            }


            // Check Exclusions
            const relativePath = vscode.workspace.asRelativePath(filePath);
            const isExcluded = this.excludePatterns.some(
                (pattern) => minimatch(relativePath, pattern)
            );

            if (isExcluded) {
                this.channel.appendLine(`Anthrax: File excluded by pattern: ${filePath}`);

                return false;
            }

            // Check file extension
            const fileExt = path.extname(filePath).toLowerCase().slice(1);
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

            const shouldTrack = Boolean(fileExt) && trackedExtensions.includes(fileExt);
            this.channel.appendLine(`Anthrax: File ${shouldTrack ? 'will' : 'will not'} be tracked: ${filePath}`)

            return shouldTrack;

        } catch (error) {
            this.channel.appendLine('Error in File tracking check');

            throw new Error;
        }

    }

    updateExcludePatterns(newPatterns: string[]) {
        this.excludePatterns = newPatterns;

        this.channel.appendLine(`Anthrax: Updated exclude patterns to: ${newPatterns.join(', ')}`);
    }

    getChangedFiles(): Change[] {
        this.channel.appendLine(`Anthrax: Returning tracked changes`);
        
        return Array.from(this.changes.values());
    }

    clearChanges(): void {
        const previousCount = this.changes.size;

        this.changes.clear();
        this.channel.appendLine(`Anthrax: Cleared ${previousCount} tracked changes`);
    }
}

/* eslint-disable no-unused-vars */
/* eslint-disable no-useless-escape */
// src/services/summaryGenerator.ts
import * as vscode from 'vscode';
import * as path from 'path';
import { Change } from './tracker';
import { ProjectContext } from './projectContext';

interface CommitHistory {
    timestamp: number;
    summary: string;
    files: string[];
    hash?: string;
}

export class SummaryGenerator {
    private channel: vscode.OutputChannel;
    private projectContext: ProjectContext;

    private commitHistory: CommitHistory[] = [];

    constructor(channel: vscode.OutputChannel, extensionContext: vscode.ExtensionContext) {
        this.channel = channel;
        this.projectContext = new ProjectContext(channel, extensionContext);
    }


    async generateSummary(changedFiles: Change[]): Promise<string> {
        try {
            const timeStamp = new Date().toISOString();

            let summary = `Syncforge Update - ${timeStamp}\n\n`;


            // Get Detailed file changes and snippets
            const changePromises = changedFiles.map(
                async (change) => {
                    const { details, snippets } = await this.getFileChanges(change);

                    return {
                        details,
                        snippets,
                        type: change.type,
                    };
                }
            );


            const changes = await Promise.all(changePromises);

            // Add change details
            summary += 'Changes:\n';
            changes.forEach(
                (change) => {
                    if (change.details) {
                        summary += `- ${change.type}: ${change.details}\n`;
                    }
                }
            );

            // Add code snippets
            summary += '\nCode Snippets:\n';
            changes.forEach((change) => {
                if (change.snippets) {
                    summary += `\n${change.snippets}\n`;
                }
            });


            // Save commit info
            await this.projectContext.addCommit(summary, changedFiles);

            this.channel.appendLine(`Syncforge: Generated commit summary with code snippets`);

            return summary;

        } catch (error) {
            this.channel.appendLine(`Syncforge: Error generating summary: ${error}`);

            return `syncforge Update - ${new Date().toISOString()}\nUpdated files`;
        }
    }


    private async getFileChanges(change: Change): Promise<{ details: string, snippets: string }> {
        try {
            // We extract old and new uri for the files (Same in the case of the modification) for rest of the cases(add, del) we set either one of them undefined.
            const oldURI = change.type === 'added' ? undefined : change.uri;           // If the type is added: sets oldURI to undefined
            const newURI = change.type === 'deleted' ? undefined : change.uri;         // Same here for deleted to newURI


            // For the case where both old and new are undefined we return empty.
            if (!oldURI && !newURI) {
                return { details: '', snippets: '' };
            }


            // Uitlizing git to determine changes in the same file (Modifications) using different versions
            const gitExt = vscode.extensions.getExtension('vscode.git');
            if (!gitExt) {
                return { details: '', snippets: '' };
            }

            const git = gitExt.exports.getAPI(1);
            if (!git.repositories.length) {
                return { details: '', snippets: '' };
            }

            const repo = git.repositories[0];

            const diff = await repo.diff(oldURI, newURI);
            const parsedChanges = await this.parseDiff(diff, change.uri);

            // Get the current contents of the file for snippet
            const currentContent = change.type !== 'deleted' ? await this.getFileContent(change.uri) : '';


            return {
                details: parsedChanges,
                snippets: this.formatCodeSnippet(
                    currentContent,
                    path.basename(change.uri.fsPath),
                ),
            };

        } catch (error) {
            this.channel.appendLine(`Error getting file changes: ${error}`);
            return { details: '', snippets: '' };
        }

    }


    // Beautifies the diff returned by git into anctions made in each file.
    private parseDiff(diff: string, uri: vscode.Uri): string {
        if (!diff) {
            return path.basename(uri.fsPath);
        }

        const lines = diff.split('\n');
        const changes: {
            modified: Set<string>;
            added: Set<string>;
            removed: Set<string>;
        } = {
            modified: new Set(),
            added: new Set(),
            removed: new Set(),
        };

        let currentFunction = '';

        for (const line of lines) {
            if (!line.trim() || line.match(/^[\+\-]\s*\/\//)) {
                continue;
            }

            const functionMatch = line.match(
                /^([\+\-])\s*(async\s+)?((function|class|const|let|var)\s+)?([a-zA-Z_$][a-zA-Z0-9_$]*)/
            );

            if (functionMatch) {
                const [_, changeType, _async, _keyword, _type, name] = functionMatch;

                if (changeType === '+') {
                    changes.added.add(name);
                } else if (changeType === '-') {
                    changes.removed.add(name);
                }

                if (changes.added.has(name) && changes.removed.has(name)) {
                    changes.modified.add(name);
                    changes.added.delete(name);
                    changes.removed.delete(name);
                }
            }
        }

        const descriptions: string[] = [];
        const filename = path.basename(uri.fsPath);

        if (changes.modified.size > 0) {
            descriptions.push(`modified ${Array.from(changes.modified).join(', ')}`);
        }
        if (changes.added.size > 0) {
            descriptions.push(`added ${Array.from(changes.added).join(', ')}`);
        }
        if (changes.removed.size > 0) {
            descriptions.push(`removed ${Array.from(changes.removed).join(', ')}`);
        }

        return descriptions.length > 0
            ? `${filename} (${descriptions.join('; ')})`
            : filename;
    }

    private async getFileContent(uri: vscode.Uri): Promise<string> {
        try {
            const document = await vscode.workspace.openTextDocument(uri);

            return document.getText();

        } catch (error) {
            this.channel.appendLine(`Error reading file content: ${error}`);
            return '';
        }
    }

    private formatCodeSnippet(content: string, filename: string): string {
        // Only include up to 50 lines of code to keep commits reasonable
        const lines = content.split('\n').slice(0, 50);
        if (content.split('\n').length > 50) {
            lines.push('... (truncated for brevity)');
        }

        return `\`\`\`\n${filename}:\n${lines.join('\n')}\n\`\`\``;
    }
}
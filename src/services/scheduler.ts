// services/scheduler.ts
import * as vscode from 'vscode';
import { setTimeout, clearInterval, setInterval } from 'node:timers';
import { Tracker } from './tracker';
import { SummaryGenerator } from './summaryGenerator';
import { GitService } from './gitService';
import { OutputChannel } from 'vscode';


export class Scheduler {
    private timer: ReturnType<typeof setTimeout> | null = null;

    private isCommiting: boolean = false;
    private pendingChanges: boolean = false;

    constructor(
        // The private keyword automatically assigns parameters to class properties, so no need to do extra assignments.
        private commitFrequency: number,
        private tracker: Tracker,
        private summaryGenerator: SummaryGenerator,
        private gitService: GitService,
        private channel: OutputChannel
    ) { }

    start() {
        if (this.timer) {
            clearInterval(this.timer);
        }

        this.timer = setInterval(
            () => this.commitChanges(),

            this.commitFrequency * 60 * 1000

        );

        // this.channel.appendLine(`Scheduler: Started with a frequency of ${this.commitFrequency} minutes.`);

        this.channel.appendLine(`Scheduler: Started with a frequency of 30 minutes.`);
    }

    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
            this.channel.appendLine('Scheduler: Stopped.');
        }
    }

    async commitChanges() {
        if (this.isCommiting) {
            this.pendingChanges = true;

            this.channel.appendLine('Scheduler: Commit already in progress, queuing changes.');

            return;
        }

        const changedFiles = this.tracker.getChangedFiles();
        if (changedFiles.length === 0) {
            this.channel.appendLine('Scheduler: No changes detected.');

            return;
        }

        try {
            this.isCommiting = true;

            const commitMessage = await this.summaryGenerator.generateSummary(changedFiles);

            const config = vscode.workspace.getConfiguration('syncforge');
            if (config.get<boolean>('confirmBeforeCommit', true)) {
                const condensedMessage = this.createCondensedMessage(commitMessage);

                const userResponse = await vscode.window.showInformationMessage(
                    `Syncforge: A commit will be made with the following changes:\n"${condensedMessage}"`,
                    { modal: true },
                    'Proceed'
                );

                if (userResponse !== 'Proceed') {
                    this.channel.appendLine('Scheduler: Commit canceled by the user.');

                    return;
                }
            }

            await this.gitService.commitAndPush(commitMessage);

            this.tracker.clearChanges();

            this.channel.appendLine(`Scheduler: Committed changes with message "${commitMessage}".`);

        } catch (error: any) {
            this.channel.appendLine(
                `Scheduler: Failed to commit changes. ${error.message}`
            );
            vscode.window.showErrorMessage(`Syncforge: Commit failed. ${error.message}`);
        } finally {
            this.isCommiting = false;

            if (this.pendingChanges) {
                this.pendingChanges = false;
                this.channel.appendLine('Scheduler: Processing pending changes...');

                setTimeout(() => this.commitChanges(), 5000); // Wait 5 seconds before processing pending changes
            }
        }
    }


    // Create a condensed version of the commit message for the dialog
    private createCondensedMessage(fullMessage: string): string {
        // Extract just the first part of the message (before code snippets)
        const parts = fullMessage.split('Code Snippets:');
        let condensed = parts[0].trim();

        // Add a count of affected files instead of showing all snippets
        const codeBlockCount = (fullMessage.match(/```/g) || []).length / 2;
        condensed += `\n(${codeBlockCount} file${codeBlockCount !== 1 ? 's' : ''} modified)`;

        // Limit to a reasonable length
        if (condensed.length > 500) {
            condensed = condensed.substring(0, 497) + '...';
        }

        return condensed;
    }


    updateFrequency(newFrequency: number) {
        this.commitFrequency = newFrequency;
        this.start(); // Restart the scheduler with the new frequency
        this.channel.appendLine(`Scheduler: Updated commit frequency to ${newFrequency} minutes.`);
    }

}

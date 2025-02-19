import * as vscode from 'vscode';

export class StatusBarManager {
    private workspaceStatusBar: vscode.StatusBarItem;
    private trackingStatusBar: vscode.StatusBarItem;
    private authStatusBar: vscode.StatusBarItem;
    
    constructor() {
        // Create workspace status Item
        this.workspaceStatusBar = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Right,
            102
        );
        this.workspaceStatusBar.text = '$(folder) Open Folder to Start';
        this.workspaceStatusBar.command = 'anthrax.openFolder'

        
        // Create tracking status Item
        this.trackingStatusBar = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Right,
            101
        );
        this.trackingStatusBar.text = '$(circle-slash) Anthrax: Stopped';
        this.trackingStatusBar.command = 'anthrax.startTracking'        
        
        
        // Create auth status Item
        this.authStatusBar = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Right,
            100
        );
        this.authStatusBar.text = '$(mark-github) Anthrax: Not Connected';
        this.authStatusBar.command = 'anthrax.login'


        // Intital Update
        this.updateVisibilty()


        // Listen for workspace folders change
        vscode.workspace.onDidChangeWorkspaceFolders(() => {
            this.updateVisibilty();
        })
    }
    
    
    private hasWorkspace(): boolean {
        return (vscode.workspace.workspaceFolders ?? []).length > 0;
    }


    private updateVisibilty() {
        if (this.hasWorkspace()) {
            this.workspaceStatusBar.hide();
            this.trackingStatusBar.show();
            this.authStatusBar.show();
        } else {
            this.workspaceStatusBar.show();
            this.trackingStatusBar.hide();
            this.authStatusBar.hide();
        }
    }


}
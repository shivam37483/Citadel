import * as vscode from 'vscode';
import { StatusBarManager } from './services/statusBarManager';

let statusBarManager: StatusBarManager;

export async function activate(context: vscode.ExtensionContext) {
    console.log("Anthrax extension activated!"); // Debugging line

    statusBarManager = new StatusBarManager();
    
    let dummy = vscode.commands.registerCommand('anthrax.test', () => {
        vscode.window.showInformationMessage("Beginnign of a whole new goddamn world");
        console.log("Anthrax extension Displayed something!"); // Debugging line
    });
    context.subscriptions.push(dummy);
}


export function deactivate() {}
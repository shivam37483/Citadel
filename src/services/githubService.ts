import * as vscode from "vscode";
import { OutputChannel } from "vscode";
import { Octokit } from "@octokit/rest";


export class GitHubService {
    
    private octokit!: Octokit;            // Without !, TypeScript would throw an error as the value is not intialized in constructor. The ! operator is a TypeScript non-null assertion, ensuring octokit is assigned before use.
    private token: String = '';
    private outputChannel: OutputChannel;
    
    constructor(outputChannel: OutputChannel) {
        this.outputChannel = outputChannel;

        // Token will be set via setToken method using octokit
    }


     /**
   * Sets the GitHub token and initializes Octokit.
   * @param token - The Gi  tHub access token obtained via OAuth.
   */
    setToken(token: String) {
        this.token = token;
        this.octokit = new Octokit({
            auth: this.token
        });
    }


    /**
   * Creates a new repository for the authenticated user.
   * @param repoName - The name of the repository to create.
   * @param description - (Optional) Description of the repository.
   * @returns The clone URL of the created repository or null if creation failed.
   */
    async createRepo(repoName: string, description: string = 'Anthrax Repository'): Promise<string | null> {
        try {
            const response = await this.octokit.repos.createForAuthenticatedUser({
                name: repoName,
                description,
                private: false                         // Whether the repo is pvt
            });

            return response.data.clone_url;            
        } catch (error: any) {
            this.outputChannel.appendLine(`Error creating repository: ${error.message}`);
        };

        vscode.window.showErrorMessage(`Failed to create repository: ${repoName}`);

        return null;
    }


    /**
   * Retrieves the authenticated user's GitHub username.
   * @returns The GitHub username or null if retrieval failed.
   */
    async getUsername(): Promise<string | null> {
        try {
            const { data } = await this.octokit.users.getAuthenticated();

            return data.login;
        } catch (error: any) {
            this.outputChannel.appendLine(`Error fetching username: ${error.message}`);
        }
        vscode.window.showErrorMessage('Unable to fetch GitHub username');

        return null;
    }


    /**
   * Checks if a repository exists for the authenticated user.
   * @param repoName - The name of the repository to check.
   * @returns True if the repository exists, false otherwise.
   */
    async repoExists(repoName: string): Promise<boolean> {
        try {
            const username = await this.getUsername();

            if (!username) {
                vscode.window.showErrorMessage('Unable to fetch GitHub username inside repoexists');
                return false;
            }

            await this.octokit.repos.get({
                owner: username,
                repo: repoName,
            });

            return true
        } catch (error: any) {
            if (error.status == 404){
                return false;
            }

            vscode.window.showErrorMessage(`Error checking repository "${repoName}".`);

            return false;
        }
    }
}
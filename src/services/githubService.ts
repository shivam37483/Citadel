import * as vscode from "vscode";
import { OutputChannel } from "vscode";
import { Octokit } from "@octokit/rest";


export class GitHubService {

    private octokit!: Octokit;            // Without !, TypeScript would throw an error as the value is not intialized in constructor. The ! operator is a TypeScript non-null assertion, ensuring octokit is assigned before use.
    public token: String = '';
    private outputChannel: OutputChannel;

    public reponame: string = '';

    constructor(outputChannel: OutputChannel) {
        this.outputChannel = outputChannel;
    }


    /**
  * Sets the GitHub token and initializes Octokit.
  * @param token - The GitHub access token obtained via OAuth.
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
    async createRepo(repoName: string, description: string = 'Syncforge Repository'): Promise<string | null> {
        this.reponame = repoName;
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
            if (error.status == 404) {
                return false;
            }

            vscode.window.showErrorMessage(`Error checking repository "${repoName}".`);

            return false;
        }
    }

    public async enableGitHubPages(owner: string, repo: string, branch: string, path: string): Promise<any> {
        const url = `https://api.github.com/repos/${owner}/${repo}/pages`;
        const body = {
            source: {
                branch: branch,
                path: path,
            },
        };
        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.token}`,
                    'Accept': 'application/vnd.github.v3+json',
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(body),
            });
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            return response;
        } catch (error) {
            this.outputChannel.appendLine(`GitHubService: Error enabling GitHub Pages - ${error}`);
            throw error;
        }
    }
}
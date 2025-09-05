import { execSync } from 'child_process';
import { join } from 'path';

export interface GitCommit {
    hash: string;
    fullHash: string;
    date: Date;
    author: string;
    email: string;
    message: string;
    summary: string; // First line of commit message
    filesChanged: string[];
}

export interface GitRemoteInfo {
    url: string;
    platform: 'github' | 'gitlab' | 'bitbucket' | 'other';
    baseUrl: string;
}

export async function getFileGitHistory(filePath: string): Promise<GitCommit[]> {
    try {
        // Resolve the absolute path to the file
        const absolutePath = join(process.cwd(), filePath);

        // We don't need branch info anymore since it's not displayed

        // Git log command to get commits that modified this specific file
        // Format: fullhash|shortHash|date|author|email|subject|body
        const gitCommand = `git log --follow --pretty=format:"%H|%h|%ad|%an|%ae|%s|%b" --date=iso --name-only -- "${absolutePath}"`;

        const output = execSync(gitCommand, {
            encoding: 'utf8',
            cwd: process.cwd()
        }).trim();

        if (!output) {
            return [];
        }

        // Parse the complex git log output
        const commits: GitCommit[] = [];
        const lines = output.split('\n');
        let i = 0;

        while (i < lines.length) {
            const line = lines[i];
            if (!line.trim()) {
                i++;
                continue;
            }

            const parts = line.split('|');
            if (parts.length >= 6) {
                const [fullHash, shortHash, dateStr, author, email, subject] = parts;
                let body = parts.slice(6).join('|');
                i++;

                // Collect file names until we hit the next commit or end
                const filesChanged: string[] = [];
                while (i < lines.length && lines[i] && !lines[i].includes('|')) {
                    const fileName = lines[i].trim();
                    if (fileName && !fileName.startsWith('commit ')) {
                        filesChanged.push(fileName);
                    }
                    i++;
                }

                // Only include commits that actually modified our target file
                const targetFile = filePath.replace(/^src\//, '');
                if (filesChanged.some(file => file.includes(targetFile) || file.endsWith(targetFile.split('/').pop() || ''))) {
                    commits.push({
                        hash: shortHash,
                        fullHash: fullHash,
                        date: new Date(dateStr),
                        author,
                        email,
                        message: body ? `${subject}\n\n${body}` : subject,
                        summary: subject,
                        filesChanged
                    });
                }
            } else {
                i++;
            }
        }

        return commits;
    } catch (error) {
        console.warn(`Failed to get git history for ${filePath}:`, error);
        return [];
    }
}

export async function getGitRemoteInfo(): Promise<GitRemoteInfo | null> {
    try {
        // First try to get remote URL from git config
        let remoteUrl: string | null = null;

        try {
            remoteUrl = execSync('git config --get remote.origin.url', {
                encoding: 'utf8',
                cwd: process.cwd()
            }).trim();
        } catch (gitError) {
            // Git command failed, try environment variables as fallback
            console.warn('Git command failed, trying environment variables:', gitError);
        }

        // If git command failed or returned empty, try environment variables
        if (!remoteUrl) {
            remoteUrl = process.env.GIT_REMOTE_URL || process.env.VERCEL_GIT_REPO_URL;
        }

        if (!remoteUrl) {
            return null;
        }

        // Parse different Git hosting platforms
        let platform: GitRemoteInfo['platform'] = 'other';
        let baseUrl = '';

        if (remoteUrl.includes('github.com')) {
            platform = 'github';
            // Convert SSH/HTTPS URLs to HTTPS format
            const match = remoteUrl.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/);
            if (match) {
                baseUrl = `https://github.com/${match[1]}/${match[2]}`;
            }
        } else if (remoteUrl.includes('gitlab.com')) {
            platform = 'gitlab';
            const match = remoteUrl.match(/gitlab\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/);
            if (match) {
                baseUrl = `https://gitlab.com/${match[1]}/${match[2]}`;
            }
        } else if (remoteUrl.includes('bitbucket.org')) {
            platform = 'bitbucket';
            const match = remoteUrl.match(/bitbucket\.org[:/]([^/]+)\/(.+?)(?:\.git)?$/);
            if (match) {
                baseUrl = `https://bitbucket.org/${match[1]}/${match[2]}`;
            }
        }

        return {
            url: remoteUrl,
            platform,
            baseUrl
        };
    } catch (error) {
        console.warn('Failed to get git remote info:', error);
        return null;
    }
}

export function generateCommitUrl(remoteInfo: GitRemoteInfo | null, fullHash: string): string | null {
    if (!remoteInfo || !remoteInfo.baseUrl) {
        return null;
    }

    switch (remoteInfo.platform) {
        case 'github':
            return `${remoteInfo.baseUrl}/commit/${fullHash}`;
        case 'gitlab':
            return `${remoteInfo.baseUrl}/-/commit/${fullHash}`;
        case 'bitbucket':
            return `${remoteInfo.baseUrl}/commits/${fullHash}`;
        default:
            return null;
    }
}

export function formatRelativeDate(date: Date): string {
    const now = new Date();
    const diffInSeconds = Math.floor((now.getTime() - date.getTime()) / 1000);

    if (diffInSeconds < 60) return 'just now';
    if (diffInSeconds < 3600) return `${Math.floor(diffInSeconds / 60)} minutes ago`;
    if (diffInSeconds < 86400) return `${Math.floor(diffInSeconds / 3600)} hours ago`;
    if (diffInSeconds < 2592000) return `${Math.floor(diffInSeconds / 86400)} days ago`;
    if (diffInSeconds < 31536000) return `${Math.floor(diffInSeconds / 2592000)} months ago`;

    return `${Math.floor(diffInSeconds / 31536000)} years ago`;
}

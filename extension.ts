import * as vscode from 'vscode';
import * as path from 'path';
import { exec } from 'child_process';
import * as fs from 'fs';

let outputPanel: vscode.WebviewPanel | undefined;
let outputHistory: { time: string; content: string; type: string }[] = [];

export function activate(context: vscode.ExtensionContext) {

    // ✅ CodeLens inside test.php
    const codeLensProvider: vscode.CodeLensProvider = {
        provideCodeLenses(document) {

            if (!document.fileName.includes('.playground')) return [];

            return [
                new vscode.CodeLens(
                    new vscode.Range(0, 0, 0, 0),
                    {
                        title: '▶ Execute Laravel Code',
                        command: 'laravel-playground.execute'
                    }
                )
            ];
        }
    };

    context.subscriptions.push(
        vscode.languages.registerCodeLensProvider(
            { scheme: 'file', language: 'php' },
            codeLensProvider
        )
    );

    // 🔹 Open Playground
    const openCommand = vscode.commands.registerCommand('laravel-playground.run', async () => {

        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            vscode.window.showErrorMessage('Open workspace first');
            return;
        }

        const dir = vscode.Uri.joinPath(workspaceFolder.uri, '.playground');
        const file = vscode.Uri.joinPath(dir, 'test.php');

        await vscode.workspace.fs.createDirectory(dir);

        try {
            await vscode.workspace.fs.stat(file);
        } catch {
            const code = `<?php

use App\\Models\\User;

$data = User::first();

dd($data);
`;
            await vscode.workspace.fs.writeFile(file, Buffer.from(code));
        }

        const doc = await vscode.workspace.openTextDocument(file);
        vscode.window.showTextDocument(doc);
    });

    // 🔹 Execute Code
    const executeCommand = vscode.commands.registerCommand('laravel-playground.execute', async () => {

        const editor = vscode.window.activeTextEditor;
        if (!editor) return;

        const code = editor.document.getText();

        if (!outputPanel) {
            outputPanel = vscode.window.createWebviewPanel(
                'laravelOutput',
                'Laravel Playground',
                vscode.ViewColumn.Two,
                { enableScripts: true, retainContextWhenHidden: true }
            );

            // ✅ Listen for Clear All
            outputPanel.webview.onDidReceiveMessage(msg => {
                if (msg.command === 'clear') {
                    outputHistory = [];
                    render();
                }
            });

            outputPanel.onDidDispose(() => outputPanel = undefined);
        } else {
            outputPanel.reveal(vscode.ViewColumn.Two);
        }

        outputPanel.webview.html = getLoadingHtml();

        await runCode(code);
    });

    context.subscriptions.push(openCommand, executeCommand);
}

// 🔹 Run Code
async function runCode(code: string) {

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) return;

    const root = workspaceFolder.uri.fsPath;
    const tempDir = path.join(root, '.playground');
    const tempFile = path.join(tempDir, 'temp.php');

    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

    const cleaned = code
        .replace(/^\s*<\?php\s*/i, '')
        .replace(/\?>\s*$/, '');

    const wrapped = `<?php
require __DIR__ . '/../vendor/autoload.php';
$app = require_once __DIR__ . '/../bootstrap/app.php';
$kernel = $app->make(Illuminate\\Contracts\\Console\\Kernel::class);
$kernel->bootstrap();

${cleaned}
`;

    fs.writeFileSync(tempFile, wrapped);

    exec(`php "${tempFile}"`, { cwd: root }, (err, stdout, stderr) => {

        const raw = stdout || stderr || 'No output';

        let type = 'text';
        if (err) type = 'error';
        else if (tryParseJSON(raw)) type = 'json';
        else if (isHTML(raw)) type = 'html';

        outputHistory.unshift({
            time: new Date().toLocaleTimeString(),
            content: raw,
            type
        });

        render();

        try { fs.unlinkSync(tempFile); } catch {}
    });
}

// 🔹 Render UI
function render() {

    if (!outputPanel) return;

    const items = outputHistory.map((item, i) => {

        let body = '';

        if (item.type === 'json') {
            body = `<pre>${escapeHtml(JSON.stringify(tryParseJSON(item.content), null, 2))}</pre>`;
        } else if (item.type === 'html') {
            body = `<iframe srcdoc="${escapeHtml(item.content)}"></iframe>`;
        } else {
            body = `<pre>${escapeHtml(item.content)}</pre>`;
        }

        return `
        <div class="card" data-raw="${escapeHtml(item.content)}">
            <div class="header">
                <span>Run #${outputHistory.length - i} (${item.time})</span>
                <button onclick="copy(${i}, this)">Copy</button>
            </div>
            ${body}
        </div>`;
    }).join('');

    outputPanel.webview.html = `
    <!DOCTYPE html>
    <html>
    <head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
    <style>
    body {
        font-family: var(--vscode-editor-font-family);
        font-size: var(--vscode-editor-font-size);
        background: var(--vscode-editor-background);
        color: var(--vscode-editor-foreground);
        padding:20px;
    }

    .topbar {
        display:flex;
        justify-content:space-between;
        align-items:center;
        margin-bottom:10px;
    }

    input {
        flex:1;
        padding:8px;
        margin-right:10px;
        background: var(--vscode-input-background);
        color: var(--vscode-input-foreground);
        border:1px solid var(--vscode-input-border);
    }

    .clear-btn {
        background: var(--vscode-button-secondaryBackground);
        color: var(--vscode-button-secondaryForeground);
        border:none;
        padding:6px 12px;
        cursor:pointer;
    }

    .result-count {
        margin-bottom:15px;
        font-size:12px;
        opacity:0.7;
    }

    .card {
        border:1px solid var(--vscode-editorGroup-border);
        margin-bottom:15px;
        padding:10px;
        border-radius:6px;
    }

    .header {
        display:flex;
        justify-content:space-between;
        margin-bottom:10px;
        font-size:12px;
    }

    pre {
        padding:10px;
        overflow:auto;
        background:#2d2d2d;
        color:#ffffff;
        border-radius:4px;

        font-family: var(--vscode-editor-font-family);
        font-size: var(--vscode-editor-font-size);
        line-height:1.6;
        letter-spacing:0.2px;

        font-weight:500;
    }

    iframe {
        width:100%;
        height:300px;
        border:none;
        background:white;
    }

    button {
        background: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
        border:none;
        padding:4px 10px;
        cursor:pointer;
    }

    mark {
        background: yellow;
        color: black;
    }

    .toast {
        position:fixed;
        bottom:20px;
        right:20px;
        background:#333;
        color:#fff;
        padding:8px 12px;
        border-radius:4px;
        font-size:12px;
    }
    </style>
    </head>
    <body>

    <h3>Laravel Playground</h3>

    <div class="topbar">
        <input placeholder="🔍 Search output..." oninput="search(this.value)" />
        <button class="clear-btn" onclick="clearAll()">Clear All</button>
    </div>

    <div class="result-count" id="resultCount">Showing all results</div>

    ${items}

    <script>
    const vscode = acquireVsCodeApi(); // ✅ FIXED

    function copy(i, btn) {
        const data = ${JSON.stringify(outputHistory)}[i].content;
        navigator.clipboard.writeText(data);

        const old = btn.innerText;
        btn.innerText = "Copied!";
        setTimeout(() => btn.innerText = old, 1500);
    }

    function clearAll() {
        vscode.postMessage({ command: 'clear' });

        const msg = document.createElement('div');
        msg.className = 'toast';
        msg.innerText = "Cleared!";
        document.body.appendChild(msg);

        setTimeout(() => msg.remove(), 1500);
    }

    function search(q) {
        q = q.toLowerCase();
        let totalMatches = 0;

        document.querySelectorAll('.card').forEach(card => {

            const raw = card.getAttribute('data-raw');
            const pre = card.querySelector('pre');

            if (!pre) return;

            if (!q) {
                pre.innerHTML = raw;
                card.style.display = 'block';
                return;
            }

            const regex = new RegExp(q, 'gi');
            const matches = raw.match(regex);
            const count = matches ? matches.length : 0;

            if (count > 0) {
                totalMatches += count;
                card.style.display = 'block';
                pre.innerHTML = raw.replace(regex, '<mark>$&</mark>');
            } else {
                card.style.display = 'none';
            }
        });

        const label = document.getElementById('resultCount');
        if (!q) {
            label.innerText = "Showing all results";
        } else {
            label.innerText = totalMatches + " matches found";
        }
    }
    </script>

    </body>
    </html>`;
}

// helpers
function tryParseJSON(str: string) {
    try { return JSON.parse(str); } catch { return null; }
}

function isHTML(str: string) {
    return /<\/?[a-z][\s\S]*>/i.test(str);
}

function escapeHtml(text: string): string {
    return text.replace(/[&<>"']/g, m => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;'
    }[m]!));
}

function getLoadingHtml(): string {
    return `<html><body><h3>⏳ Running...</h3></body></html>`;
}

export function deactivate() {
    outputPanel?.dispose();
}


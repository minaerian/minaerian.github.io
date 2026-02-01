// Shared post rendering logic
document.addEventListener('DOMContentLoaded', async () => {
    const contentDiv = document.getElementById('post-content');
    if (!contentDiv) return;

    try {
        const response = await fetch('index.md');
        if (!response.ok) throw new Error('Post not found');
        
        let markdown = await response.text();
        
        // Remove YAML frontmatter
        markdown = markdown.replace(/^---[\s\S]*?---\n*/m, '');
        
        // Convert markdown to HTML (simple conversion)
        const html = markdownToHtml(markdown);
        contentDiv.innerHTML = html;
        
        // Syntax highlighting for code blocks
        document.querySelectorAll('pre code').forEach(block => {
            block.className = 'language-' + (block.className || 'plaintext');
        });
    } catch (error) {
        contentDiv.innerHTML = '<p class="error">Error loading post content.</p>';
        console.error(error);
    }
});

function markdownToHtml(md) {
    let html = md
        // Code blocks (must be first)
        .replace(/```(\w+)?\n([\s\S]*?)```/g, (_, lang, code) => {
            return `<pre><code class="${lang || ''}">${escapeHtml(code.trim())}</code></pre>`;
        })
        // Inline code
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        // Headers
        .replace(/^#### (.+)$/gm, '<h4>$1</h4>')
        .replace(/^### (.+)$/gm, '<h3>$1</h3>')
        .replace(/^## (.+)$/gm, '<h2>$1</h2>')
        .replace(/^# (.+)$/gm, '<h1>$1</h1>')
        // Bold and italic
        .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.+?)\*/g, '<em>$1</em>')
        // Links
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
        // Images
        .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1">')
        // Blockquotes
        .replace(/^> (.+)$/gm, '<blockquote>$1</blockquote>')
        // Unordered lists
        .replace(/^- (.+)$/gm, '<li>$1</li>')
        // Horizontal rules
        .replace(/^---$/gm, '<hr>')
        // Paragraphs (must be last)
        .replace(/\n\n+/g, '</p><p>')
        .replace(/^(?!<[hpuolbic])(.+)$/gm, '<p>$1</p>');
    
    // Wrap consecutive li elements in ul
    html = html.replace(/(<li>.*?<\/li>\n?)+/g, '<ul>$&</ul>');
    
    // Clean up empty paragraphs and fix blockquotes
    html = html.replace(/<p><\/p>/g, '');
    html = html.replace(/<\/blockquote>\s*<blockquote>/g, '<br>');
    
    return html;
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

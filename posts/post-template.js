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
        
        // Convert markdown to HTML
        const html = markdownToHtml(markdown);
        contentDiv.innerHTML = html;
    } catch (error) {
        contentDiv.innerHTML = '<p class="error">Error loading post content.</p>';
        console.error(error);
    }
});

function markdownToHtml(md) {
    // Step 1: Extract code blocks and replace with placeholders
    const codeBlocks = [];
    md = md.replace(/```(\w+)?\n([\s\S]*?)```/g, (match, lang, code) => {
        const index = codeBlocks.length;
        codeBlocks.push({ lang: lang || '', code: code.trim() });
        return `%%CODEBLOCK_${index}%%`;
    });
    
    // Step 2: Extract inline code and replace with placeholders
    const inlineCode = [];
    md = md.replace(/`([^`]+)`/g, (match, code) => {
        const index = inlineCode.length;
        inlineCode.push(code);
        return `%%INLINE_${index}%%`;
    });
    
    // Step 3: Process markdown (headers, formatting, etc.)
    let html = md
        // Headers (only at start of line, not inside other content)
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
        // Numbered lists
        .replace(/^\d+\. (.+)$/gm, '<li>$1</li>')
        // Horizontal rules
        .replace(/^---$/gm, '<hr>');
    
    // Step 4: Restore inline code
    inlineCode.forEach((code, index) => {
        html = html.replace(`%%INLINE_${index}%%`, `<code>${escapeHtml(code)}</code>`);
    });
    
    // Step 5: Restore code blocks
    codeBlocks.forEach((block, index) => {
        const escapedCode = escapeHtml(block.code);
        html = html.replace(
            `%%CODEBLOCK_${index}%%`,
            `<pre><code class="language-${block.lang}">${escapedCode}</code></pre>`
        );
    });
    
    // Step 6: Wrap in paragraphs
    html = html
        .split(/\n\n+/)
        .map(block => {
            block = block.trim();
            if (!block) return '';
            // Don't wrap block elements
            if (block.startsWith('<h') || 
                block.startsWith('<pre') || 
                block.startsWith('<ul') || 
                block.startsWith('<ol') || 
                block.startsWith('<li') ||
                block.startsWith('<blockquote') ||
                block.startsWith('<hr')) {
                return block;
            }
            return `<p>${block.replace(/\n/g, '<br>')}</p>`;
        })
        .join('\n');
    
    // Wrap consecutive li elements in ul
    html = html.replace(/(<li>[\s\S]*?<\/li>\s*)+/g, '<ul>$&</ul>');
    
    // Clean up
    html = html.replace(/<\/blockquote>\s*<blockquote>/g, '<br>');
    
    return html;
}

function escapeHtml(text) {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

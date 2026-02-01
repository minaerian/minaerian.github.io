/* ==========================================================================
   Mina Erian — Resume Scripts
   Subtle scroll animations and interactions
   ========================================================================== */

document.addEventListener('DOMContentLoaded', function() {
    
    // Intersection Observer for fade-in animations
    const observerOptions = {
        root: null,
        rootMargin: '0px',
        threshold: 0.1
    };

    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.classList.add('visible');
                observer.unobserve(entry.target);
            }
        });
    }, observerOptions);

    // Add animation class to elements
    const animateElements = document.querySelectorAll(`
        .origin-story,
        .discovery-main,
        .discovery-visual,
        .philosophy-card,
        .metric,
        .timeline-item,
        .toolkit-category,
        .education-item,
        .writing-card
    `);

    animateElements.forEach((el, index) => {
        el.style.opacity = '0';
        el.style.transform = 'translateY(30px)';
        el.style.transition = `opacity 0.6s ease ${index % 3 * 0.1}s, transform 0.6s ease ${index % 3 * 0.1}s`;
        observer.observe(el);
    });

    // Add visible class styles
    const style = document.createElement('style');
    style.textContent = `
        .visible {
            opacity: 1 !important;
            transform: translateY(0) !important;
        }
    `;
    document.head.appendChild(style);

    // Smooth scroll for anchor links
    document.querySelectorAll('a[href^="#"]').forEach(anchor => {
        anchor.addEventListener('click', function(e) {
            e.preventDefault();
            const target = document.querySelector(this.getAttribute('href'));
            if (target) {
                target.scrollIntoView({
                    behavior: 'smooth',
                    block: 'start'
                });
            }
        });
    });

    // Hide scroll indicator after scrolling
    const scrollIndicator = document.querySelector('.scroll-indicator');
    if (scrollIndicator) {
        window.addEventListener('scroll', function() {
            if (window.scrollY > 100) {
                scrollIndicator.style.opacity = '0';
                scrollIndicator.style.pointerEvents = 'none';
            } else {
                scrollIndicator.style.opacity = '1';
                scrollIndicator.style.pointerEvents = 'auto';
            }
        }, { passive: true });
    }

    // Add hover effect to timeline items
    const timelineItems = document.querySelectorAll('.timeline-item');
    timelineItems.forEach(item => {
        item.addEventListener('mouseenter', function() {
            this.querySelector('.timeline-content').style.transform = 'translateX(8px)';
        });
        item.addEventListener('mouseleave', function() {
            this.querySelector('.timeline-content').style.transform = 'translateX(0)';
        });
    });

    // Parallax effect on hero (subtle)
    const hero = document.querySelector('.hero');
    if (hero) {
        window.addEventListener('scroll', function() {
            const scrolled = window.scrollY;
            if (scrolled < window.innerHeight) {
                hero.style.backgroundPosition = `50% ${scrolled * 0.3}px`;
            }
        }, { passive: true });
    }

    // Console easter egg
    console.log(`
    ╔══════════════════════════════════════════════════════════╗
    ║                                                          ║
    ║   👋 Hey there, fellow developer!                        ║
    ║                                                          ║
    ║   Curious about the code? I like that.                   ║
    ║   This resume was built with vanilla HTML, CSS, and JS.  ║
    ║   No frameworks. No build step. Just fundamentals.       ║
    ║                                                          ║
    ║   Want to chat? mina.info.tech@gmail.com                 ║
    ║                                                          ║
    ╚══════════════════════════════════════════════════════════╝
    `);

});

// PDF Export functionality (for future use)
function exportToPDF() {
    window.print();
}

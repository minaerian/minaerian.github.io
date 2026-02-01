// ==========================================================================
// Star Wars Hologram Theme - Interactive Scripts
// ==========================================================================

// Star Field Animation - Subtle Apple-style
class StarField {
    constructor(canvas) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.stars = [];
        this.numStars = 100;
        this.resize();
        this.init();
        this.animate();
        
        window.addEventListener('resize', () => this.resize());
    }
    
    resize() {
        this.canvas.width = window.innerWidth;
        this.canvas.height = window.innerHeight;
    }
    
    init() {
        this.stars = [];
        for (let i = 0; i < this.numStars; i++) {
            this.stars.push({
                x: Math.random() * this.canvas.width,
                y: Math.random() * this.canvas.height,
                size: Math.random() * 1.5,
                speed: Math.random() * 0.2 + 0.05,
                opacity: Math.random() * 0.5 + 0.1,
                twinkle: Math.random() * Math.PI * 2
            });
        }
    }
    
    animate() {
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        
        this.stars.forEach(star => {
            // Subtle twinkle
            star.twinkle += 0.01;
            const opacity = star.opacity * (0.6 + Math.sin(star.twinkle) * 0.4);
            
            // Draw star - white/gray for Apple feel
            this.ctx.beginPath();
            this.ctx.arc(star.x, star.y, star.size, 0, Math.PI * 2);
            this.ctx.fillStyle = `rgba(255, 255, 255, ${opacity})`;
            this.ctx.fill();
            
            // Very slow drift
            star.y += star.speed;
            if (star.y > this.canvas.height) {
                star.y = 0;
                star.x = Math.random() * this.canvas.width;
            }
        });
        
        requestAnimationFrame(() => this.animate());
    }
}

// Initialize star field
document.addEventListener('DOMContentLoaded', () => {
    const canvas = document.getElementById('starfield');
    if (canvas) {
        new StarField(canvas);
    }
});

// Scroll Animations
const observerOptions = {
    root: null,
    rootMargin: '0px',
    threshold: 0.1
};

const scrollObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
        if (entry.isIntersecting) {
            entry.target.classList.add('visible');
            
            // Trigger counter animation for metrics
            if (entry.target.classList.contains('metric-card')) {
                animateCounter(entry.target);
            }
        }
    });
}, observerOptions);

// Observe elements
document.addEventListener('DOMContentLoaded', () => {
    // Sections
    document.querySelectorAll('.section').forEach(section => {
        scrollObserver.observe(section);
    });
    
    // Metric cards
    document.querySelectorAll('.metric-card').forEach((card, index) => {
        card.style.transitionDelay = `${index * 0.1}s`;
        scrollObserver.observe(card);
    });
    
    // Timeline items
    document.querySelectorAll('.timeline-item').forEach((item, index) => {
        item.style.transitionDelay = `${index * 0.2}s`;
        scrollObserver.observe(item);
    });
});

// Counter Animation
function animateCounter(card) {
    const valueEl = card.querySelector('.metric-value');
    if (!valueEl || valueEl.dataset.animated) return;
    
    valueEl.dataset.animated = 'true';
    
    const target = parseFloat(valueEl.dataset.count);
    const prefix = valueEl.dataset.prefix || '';
    const duration = 2000;
    const startTime = performance.now();
    const isDecimal = target % 1 !== 0;
    
    function update(currentTime) {
        const elapsed = currentTime - startTime;
        const progress = Math.min(elapsed / duration, 1);
        
        // Easing function
        const easeOut = 1 - Math.pow(1 - progress, 3);
        const current = target * easeOut;
        
        if (isDecimal) {
            valueEl.textContent = prefix + current.toFixed(2);
        } else {
            valueEl.textContent = prefix + Math.floor(current).toLocaleString();
        }
        
        if (progress < 1) {
            requestAnimationFrame(update);
        } else {
            if (isDecimal) {
                valueEl.textContent = prefix + target.toFixed(2);
            } else {
                valueEl.textContent = prefix + target.toLocaleString();
            }
        }
    }
    
    requestAnimationFrame(update);
}

// Navigation Active State
document.addEventListener('DOMContentLoaded', () => {
    const sections = document.querySelectorAll('.section');
    const navLinks = document.querySelectorAll('.nav-link');
    
    const navObserver = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                const id = entry.target.id;
                navLinks.forEach(link => {
                    link.classList.remove('active');
                    if (link.dataset.section === id) {
                        link.classList.add('active');
                    }
                });
            }
        });
    }, {
        rootMargin: '-50% 0px -50% 0px'
    });
    
    sections.forEach(section => navObserver.observe(section));
});

// Smooth scroll for nav links
document.querySelectorAll('.nav-link').forEach(link => {
    link.addEventListener('click', (e) => {
        e.preventDefault();
        const targetId = link.getAttribute('href');
        const target = document.querySelector(targetId);
        if (target) {
            target.scrollIntoView({ behavior: 'smooth' });
        }
    });
});

// Typing effect for tagline
document.addEventListener('DOMContentLoaded', () => {
    const tagline = document.querySelector('.hero-tagline');
    if (tagline) {
        const text = tagline.textContent;
        tagline.textContent = '';
        tagline.style.opacity = '1';
        
        let i = 0;
        const typeWriter = () => {
            if (i < text.length) {
                tagline.textContent += text.charAt(i);
                i++;
                setTimeout(typeWriter, 50);
            }
        };
        
        // Delay start
        setTimeout(typeWriter, 1000);
    }
});

// Layer visualization interaction
document.querySelectorAll('.layer').forEach(layer => {
    layer.addEventListener('mouseenter', () => {
        const bar = layer.querySelector('.layer-bar::after');
        // CSS handles this with :hover
    });
});

// Parallax effect on scroll (subtle)
let ticking = false;
window.addEventListener('scroll', () => {
    if (!ticking) {
        window.requestAnimationFrame(() => {
            const scrolled = window.pageYOffset;
            const hero = document.querySelector('.hero-content');
            if (hero && scrolled < window.innerHeight) {
                hero.style.transform = `translateY(${scrolled * 0.3}px)`;
                hero.style.opacity = 1 - (scrolled / window.innerHeight);
            }
            ticking = false;
        });
        ticking = true;
    }
});

// Glitch effect intensify on hover
document.querySelectorAll('.glitch').forEach(el => {
    el.addEventListener('mouseenter', () => {
        el.style.animation = 'none';
        el.offsetHeight; // Trigger reflow
        el.style.animation = null;
    });
});

// HUD corner pulse on scroll
let lastScroll = 0;
window.addEventListener('scroll', () => {
    const currentScroll = window.pageYOffset;
    const corners = document.querySelectorAll('.hud-corner');
    
    if (currentScroll > lastScroll) {
        corners.forEach(corner => {
            corner.style.opacity = '0.8';
        });
    } else {
        corners.forEach(corner => {
            corner.style.opacity = '0.5';
        });
    }
    
    lastScroll = currentScroll;
});

// Add subtle audio feedback (optional - disabled by default)
const enableAudio = false;
if (enableAudio) {
    document.querySelectorAll('.holo-btn, .holo-card, .writing-card').forEach(el => {
        el.addEventListener('mouseenter', () => {
            // Play subtle hover sound
            const audio = new Audio('data:audio/wav;base64,UklGRnoGAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQoGAACBhYqFbF1fdH2Onp+dlod7c3V/iZOWkYZ5cXB0gIuSkI2GgHx8gISIi4qHg398fH+Dh4qJhoJ+fH19gYWIiIWBfnx8fYGEhoaCf3x7fH6Ag4SCf3x7e31/gYKBfnt7e31/gYGAfXt6e31/gIB+fHp6e3x+f398enp6e3x+fn18enl6e3x9fXx7enl6ent8fHt6eXl5ent7e3p5eXl6ent7enl5eXl6enp6eXl5eXp6enp5eXl5enp6enl5eXl5enp5eXl5eXl5eXl5eXl5eQ==');
            audio.volume = 0.1;
            audio.play().catch(() => {});
        });
    });
}

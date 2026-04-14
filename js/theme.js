/**
 * Theme System
 * 
 * Simple theme/mode switching with localStorage persistence.
 * All themes pre-loaded in themes.css - instant switching.
 * 
 * Changes from previous version:
 * - No lazy loading (all themes in one CSS file)
 * - Simpler state management
 * - Migration for old theme names
 * - Search/filter support for 44 themes
 */

// Theme metadata with preview colors (embedded, no fetch needed)
// Colors: [primary, accent, info, background]
const THEMES = [
    { id: 'default', name: 'Default', colors: ["#6366f1", "#8b5cf6", "#22d3ee", "#0a0a0f"] },
    { id: 'solarized', name: 'Solarized', colors: ["#268bd2", "#6c71c4", "#2aa198", "#002b36"] },
    { id: 'amber-minimal', name: 'Amber Minimal', colors: ["oklch(0.7686 0.1647 70.0804)", "oklch(0.4732 0.1247 46.2007)", "oklch(0.2686 0 0)", "oklch(0.2046 0 0)"] },
    { id: 'amethyst-haze', name: 'Amethyst Haze', colors: ["oklch(0.7058 0.0777 302.0489)", "oklch(0.3181 0.0321 308.6149)", "oklch(0.4604 0.0472 295.5578)", "oklch(0.2166 0.0215 292.8474)"] },
    { id: 'bold-tech', name: 'Bold Tech', colors: ["oklch(0.6056 0.2189 292.7172)", "oklch(0.4568 0.2146 277.0229)", "oklch(0.2573 0.0861 281.2883)", "oklch(0.2077 0.0398 265.7549)"] },
    { id: 'bubblegum', name: 'Bubblegum', colors: ["oklch(0.9195 0.0801 87.6670)", "oklch(0.6699 0.0988 356.9762)", "oklch(0.7794 0.0803 4.1330)", "oklch(0.2497 0.0305 234.1628)"] },
    { id: 'caffeine', name: 'Caffeine', colors: ["oklch(0.9247 0.0524 66.1732)", "oklch(0.2850 0 0)", "oklch(0.3163 0.0190 63.6992)", "oklch(0.1776 0 0)"] },
    { id: 'candyland', name: 'Candyland', colors: ["oklch(0.8027 0.1355 349.2347)", "oklch(0.8148 0.0819 225.7537)", "oklch(0.7395 0.2268 142.8504)", "oklch(0.2303 0.0125 264.2926)"] },
    { id: 'catppuccin', name: 'Catppuccin', colors: ["oklch(0.7871 0.1187 304.7693)", "oklch(0.8467 0.0833 210.2545)", "oklch(0.4765 0.0340 278.6430)", "oklch(0.2155 0.0254 284.0647)"] },
    { id: 'claude', name: 'Claude', colors: ["oklch(0.6724 0.1308 38.7559)", "oklch(0.2130 0.0078 95.4245)", "oklch(0.9818 0.0054 95.0986)", "oklch(0.2679 0.0036 106.6427)"] },
    { id: 'claymorphism', name: 'Claymorphism', colors: ["oklch(0.6801 0.1583 276.9349)", "oklch(0.3896 0.0074 59.4734)", "oklch(0.3359 0.0077 59.4197)", "oklch(0.2244 0.0074 67.4370)"] },
    { id: 'clean-slate', name: 'Clean Slate', colors: ["oklch(0.6801 0.1583 276.9349)", "oklch(0.3729 0.0306 259.7328)", "oklch(0.3351 0.0331 260.9120)", "oklch(0.2077 0.0398 265.7549)"] },
    { id: 'cosmic-night', name: 'Cosmic Night', colors: ["oklch(0.7162 0.1597 290.3962)", "oklch(0.3354 0.0828 280.9705)", "oklch(0.3139 0.0736 283.4591)", "oklch(0.1743 0.0227 283.7998)"] },
    { id: 'cyberpunk', name: 'Cyberpunk', colors: ["oklch(0.6726 0.2904 341.4084)", "oklch(0.8903 0.1739 171.2690)", "oklch(0.2542 0.0611 281.1423)", "oklch(0.1649 0.0352 281.8285)"] },
    { id: 'darkmatter', name: 'Darkmatter', colors: ["oklch(0.7214 0.1337 49.9802)", "oklch(0.3211 0 0)", "oklch(0.5940 0.0443 196.0233)", "oklch(0.1797 0.0043 308.1928)"] },
    { id: 'doom-64', name: 'Doom 64', colors: ["oklch(0.6083 0.2090 27.0276)", "oklch(0.7482 0.1235 244.7492)", "oklch(0.6423 0.1467 133.0145)", "oklch(0.2178 0 0)"] },
    { id: 'elegant-luxury', name: 'Elegant Luxury', colors: ["oklch(0.5054 0.1905 27.5181)", "oklch(0.5553 0.1455 48.9975)", "oklch(0.4732 0.1247 46.2007)", "oklch(0.2161 0.0061 56.0434)"] },
    { id: 'graphite', name: 'Graphite', colors: ["oklch(0.7058 0 0)", "oklch(0.3715 0 0)", "oklch(0.3092 0 0)", "oklch(0.2178 0 0)"] },
    { id: 'kodama-grove', name: 'Kodama Grove', colors: ["oklch(0.6762 0.0567 132.4479)", "oklch(0.6540 0.0723 90.7629)", "oklch(0.4448 0.0239 84.5498)", "oklch(0.3303 0.0214 88.0737)"] },
    { id: 'midnight-bloom', name: 'Midnight Bloom', colors: ["oklch(0.5676 0.2021 283.0838)", "oklch(0.6746 0.1414 261.3380)", "oklch(0.3390 0.1793 301.6848)", "oklch(0.2303 0.0125 264.2926)"] },
    { id: 'mocha-mousse', name: 'Mocha Mousse', colors: ["oklch(0.7272 0.0539 52.3320)", "oklch(0.7473 0.0387 80.5476)", "oklch(0.5416 0.0512 37.2132)", "oklch(0.2721 0.0141 48.1783)"] },
    { id: 'modern-minimal', name: 'Modern Minimal', colors: ["oklch(0.6231 0.1880 259.8145)", "oklch(0.3791 0.1378 265.5222)", "oklch(0.2686 0 0)", "oklch(0.2046 0 0)"] },
    { id: 'mono', name: 'Mono', colors: ["oklch(0.5555 0 0)", "oklch(0.3715 0 0)", "oklch(0.2686 0 0)", "oklch(0.1448 0 0)"] },
    { id: 'nature', name: 'Nature', colors: ["oklch(0.6731 0.1624 144.2083)", "oklch(0.5752 0.1446 144.1813)", "oklch(0.3942 0.0265 142.9926)", "oklch(0.2683 0.0279 150.7681)"] },
    { id: 'neo-brutalism', name: 'Neo Brutalism', colors: ["oklch(0.7044 0.1872 23.1858)", "oklch(0.6755 0.1765 252.2592)", "oklch(0.9691 0.2005 109.6228)", "oklch(0 0 0)"] },
    { id: 'northern-lights', name: 'Northern Lights', colors: ["oklch(0.6487 0.1538 150.3071)", "oklch(0.6746 0.1414 261.3380)", "oklch(0.5880 0.0993 245.7394)", "oklch(0.2303 0.0125 264.2926)"] },
    { id: 'notebook', name: 'Notebook', colors: ["oklch(0.7572 0 0)", "oklch(0.9067 0 0)", "oklch(0.4676 0 0)", "oklch(0.2891 0 0)"] },
    { id: 'ocean-breeze', name: 'Ocean Breeze', colors: ["oklch(0.7729 0.1535 163.2231)", "oklch(0.3729 0.0306 259.7328)", "oklch(0.3351 0.0331 260.9120)", "oklch(0.2077 0.0398 265.7549)"] },
    { id: 'pastel-dreams', name: 'Pastel Dreams', colors: ["oklch(0.7874 0.1179 295.7538)", "oklch(0.3858 0.0509 304.6383)", "oklch(0.3416 0.0444 308.8496)", "oklch(0.2161 0.0061 56.0434)"] },
    { id: 'perpetuity', name: 'Perpetuity', colors: ["oklch(0.8520 0.1269 195.0354)", "oklch(0.3775 0.0564 216.5010)", "oklch(0.3775 0.0564 216.5010)", "oklch(0.2068 0.0247 224.4533)"] },
    { id: 'quantum-rose', name: 'Quantum Rose', colors: ["oklch(0.7543 0.2319 332.0212)", "oklch(0.3558 0.1201 325.7655)", "oklch(0.3184 0.0915 319.6465)", "oklch(0.1808 0.0535 313.7159)"] },
    { id: 'retro-arcade', name: 'Retro Arcade', colors: ["oklch(0.5924 0.2025 355.8943)", "oklch(0.5808 0.1732 39.5003)", "oklch(0.6437 0.1019 187.3840)", "oklch(0.2673 0.0486 219.8169)"] },
    { id: 'sage-garden', name: 'Sage Garden', colors: ["oklch(0.6333 0.0309 154.9039)", "oklch(0.3709 0.0248 153.9823)", "oklch(0.2178 0 0)", "oklch(0.1448 0 0)"] },
    { id: 'soft-pop', name: 'Soft Pop', colors: ["oklch(0.6801 0.1583 276.9349)", "oklch(0.8790 0.1534 91.6054)", "oklch(0.7845 0.1325 181.9120)", "oklch(0 0 0)"] },
    { id: 'solar-dusk', name: 'Solar Dusk', colors: ["oklch(0.7049 0.1867 47.6044)", "oklch(0.3598 0.0497 229.3202)", "oklch(0.4444 0.0096 73.6390)", "oklch(0.2161 0.0061 56.0434)"] },
    { id: 'starry-night', name: 'Starry Night', colors: ["oklch(0.4815 0.1178 263.3758)", "oklch(0.8469 0.0524 264.7751)", "oklch(0.9097 0.1440 95.1120)", "oklch(0.2204 0.0198 275.8439)"] },
    { id: 'sunset-horizon', name: 'Sunset Horizon', colors: ["oklch(0.7357 0.1641 34.7091)", "oklch(0.8278 0.1131 57.9984)", "oklch(0.3637 0.0203 342.2664)", "oklch(0.2569 0.0169 352.4042)"] },
    { id: 'supabase', name: 'Supabase', colors: ["oklch(0.4365 0.1044 156.7556)", "oklch(0.3132 0 0)", "oklch(0.2603 0 0)", "oklch(0.1822 0 0)"] },
    { id: 't3-chat', name: 'T3 Chat', colors: ["oklch(0.4607 0.1853 4.0994)", "oklch(0.3649 0.0508 308.4911)", "oklch(0.3137 0.0306 310.0610)", "oklch(0.2409 0.0201 307.5346)"] },
    { id: 'tangerine', name: 'Tangerine', colors: ["oklch(0.6397 0.1720 36.4421)", "oklch(0.3380 0.0589 267.5867)", "oklch(0.3095 0.0266 266.7132)", "oklch(0.2598 0.0306 262.6666)"] },
    { id: 'twitter', name: 'Twitter', colors: ["oklch(0.6692 0.1607 245.0110)", "oklch(0.1928 0.0331 242.5459)", "oklch(0.9622 0.0035 219.5331)", "oklch(0 0 0)"] },
    { id: 'vercel', name: 'Vercel', colors: ["oklch(1 0 0)", "oklch(0.3200 0 0)", "oklch(0.2500 0 0)", "oklch(0 0 0)"] },
    { id: 'vintage-paper', name: 'Vintage Paper', colors: ["oklch(0.7264 0.0581 66.6967)", "oklch(0.4186 0.0281 56.3404)", "oklch(0.3795 0.0181 57.1280)", "oklch(0.2747 0.0139 57.6523)"] },
    { id: 'violet-bloom', name: 'Violet Bloom', colors: ["oklch(0.6132 0.2294 291.7437)", "oklch(0.2795 0.0368 260.0310)", "oklch(0.2940 0.0130 272.9312)", "oklch(0.2223 0.0060 271.1393)"] },
];

// Old themes that were removed (for migration)
const REMOVED_THEMES = ['nord', 'gruvbox', 'rosepine', 'tokyonight', 'ocean', 'forest', 'monokai', 'dracula', 'midnight'];

/**
 * Set the current theme
 * @param {string} themeId - Theme identifier
 */
function setTheme(themeId) {
    // Validate theme exists
    const theme = THEMES.find(t => t.id === themeId);
    if (!theme) {
        console.warn(`Theme "${themeId}" not found, falling back to default`);
        themeId = 'default';
    }
    
    document.documentElement.dataset.theme = themeId;
    
    try {
        localStorage.setItem('kb-theme', themeId);
    } catch (e) {
        // localStorage not available
    }
    
    updateThemeIndicator();
}

/**
 * Set the current mode (light/dark)
 * @param {string} mode - 'light' or 'dark'
 */
function setMode(mode) {
    if (mode !== 'light' && mode !== 'dark') return;
    
    document.documentElement.dataset.mode = mode;
    
    try {
        localStorage.setItem('kb-mode', mode);
    } catch (e) {
        // localStorage not available
    }
    
    updateModeIndicator();
}

/**
 * Toggle between light and dark modes
 */
function toggleMode() {
    const currentMode = document.documentElement.dataset.mode || 'dark';
    const newMode = currentMode === 'dark' ? 'light' : 'dark';
    setMode(newMode);
}

/**
 * Update theme name display and checkmarks
 */
function updateThemeIndicator() {
    const current = document.documentElement.dataset.theme || 'default';
    const theme = THEMES.find(t => t.id === current);
    
    // Update button text
    document.querySelectorAll('[data-current-theme], [data-theme-name]').forEach(el => {
        el.textContent = theme?.name || 'Default';
    });
    
    // Update checkmarks
    document.querySelectorAll('[data-theme-select]').forEach(el => {
        const themeId = el.getAttribute('data-theme-select');
        const check = el.querySelector('.theme-check');
        if (check) {
            check.style.visibility = themeId === current ? 'visible' : 'hidden';
        }
        
        // Update active state
        if (themeId === current) {
            el.classList.add('active');
        } else {
            el.classList.remove('active');
        }
    });
}

/**
 * Update mode toggle icons
 */
function updateModeIndicator() {
    const mode = document.documentElement.dataset.mode || 'dark';
    // Show sun icon in dark mode (click to switch to light), moon in light mode (click to switch to dark)
    const icon = mode === 'dark' ? 'bi-sun-fill' : 'bi-moon-fill';
    const title = mode === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
    
    document.querySelectorAll('[data-mode-toggle]').forEach(btn => {
        // Handle both direct icon elements and buttons containing icons
        const iconEl = btn.tagName === 'I' ? btn : btn.querySelector('i');
        if (iconEl) {
            // Remove existing bi-* classes except 'bi'
            iconEl.className = iconEl.className.replace(/bi-\S+/g, '').trim();
            iconEl.classList.add('bi', icon);
        }
        
        btn.setAttribute('title', title);
        btn.setAttribute('aria-label', title);
    });
}

/**
 * Populate theme dropdown menus
 */
function populateThemeMenus() {
    document.querySelectorAll('[data-theme-menu]').forEach(container => {
        // Clear existing content
        container.innerHTML = '';
        
        // Add header with search only
        const headerLi = document.createElement('li');
        headerLi.className = 'p-0';
        headerLi.innerHTML = `
            <input type="text" class="form-control form-control-sm" 
                   placeholder="Search themes..." data-theme-search>
        `;
        container.appendChild(headerLi);
        
        // Add divider
        const dividerLi = document.createElement('li');
        dividerLi.innerHTML = '<hr class="dropdown-divider">';
        container.appendChild(dividerLi);
        
        // Create theme list container
        const listLi = document.createElement('li');
        const themeList = document.createElement('div');
        themeList.className = 'theme-list';
        themeList.style.maxHeight = '280px';
        themeList.style.overflowY = 'auto';
        listLi.appendChild(themeList);
        container.appendChild(listLi);
        
        // Populate themes with color squares
        THEMES.forEach(theme => {
            const item = document.createElement('button');
            item.type = 'button';
            item.className = 'dropdown-item d-flex align-items-center';
            item.setAttribute('data-theme-select', theme.id);
            
            // Create color squares HTML
            const colorsHtml = theme.colors ? 
                `<span class="theme-colors">
                    <span class="theme-color-square" style="background: ${theme.colors[0]};"></span>
                    <span class="theme-color-square" style="background: ${theme.colors[1]};"></span>
                    <span class="theme-color-square" style="background: ${theme.colors[2]};"></span>
                    <span class="theme-color-square" style="background: ${theme.colors[3]};"></span>
                </span>` : '';
            
            item.innerHTML = `
                ${colorsHtml}
                <span class="theme-name flex-grow-1">${theme.name}</span>
                <i class="bi bi-check2 theme-check ms-2" style="visibility: hidden;"></i>
            `;
            item.addEventListener('click', (e) => {
                e.preventDefault();
                setTheme(theme.id);
            });
            themeList.appendChild(item);
        });
        
        // Add footer with counter (left) and mode toggle (right)
        // Note: Click handler is added by setupModeToggles() to avoid duplicate handlers
        const footerLi = document.createElement('li');
        footerLi.innerHTML = `
            <hr class="dropdown-divider">
            <div class="theme-dropdown-footer">
                <span class="theme-counter">${THEMES.length} themes</span>
                <button type="button" class="theme-mode-toggle" data-mode-toggle title="Toggle light/dark mode">
                    <i class="bi bi-sun-fill"></i>
                </button>
            </div>
        `;
        container.appendChild(footerLi);
        
        // Get references for search functionality
        const searchInput = container.querySelector('[data-theme-search]');
        const counterEl = footerLi.querySelector('.theme-counter');
        
        // Setup search with counter update
        if (searchInput) {
            searchInput.addEventListener('input', (e) => {
                const query = e.target.value.toLowerCase().trim();
                let visibleCount = 0;
                
                themeList.querySelectorAll('[data-theme-select]').forEach(item => {
                    const nameEl = item.querySelector('.theme-name');
                    const name = nameEl ? nameEl.textContent.toLowerCase() : item.textContent.toLowerCase();
                    const visible = !query || name.includes(query);
                    
                    // Use Bootstrap's d-none class for hiding (works better with flexbox)
                    if (visible) {
                        item.classList.remove('d-none');
                        visibleCount++;
                    } else {
                        item.classList.add('d-none');
                    }
                });
                
                // Update counter
                if (counterEl) {
                    counterEl.textContent = `${visibleCount} themes`;
                }
            });
            
            // Prevent dropdown from closing when typing/clicking in search
            searchInput.addEventListener('click', (e) => e.stopPropagation());
            searchInput.addEventListener('keydown', (e) => e.stopPropagation());
        }
    });
    
    // Update indicators after populating
    updateThemeIndicator();
    updateModeIndicator();
}

/**
 * Setup mode toggle buttons
 */
function setupModeToggles() {
    document.querySelectorAll('[data-mode-toggle]').forEach(btn => {
        // Skip if already has listener (prevent duplicates)
        if (btn.dataset.modeToggleInit) return;
        btn.dataset.modeToggleInit = 'true';
        
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation(); // Prevent dropdown from closing
            toggleMode();
        });
    });
}

/**
 * Migrate from old theme names to new ones
 */
function migrateOldTheme() {
    try {
        const savedTheme = localStorage.getItem('kb-theme');
        if (savedTheme && REMOVED_THEMES.includes(savedTheme)) {
            // Old theme no longer exists, fall back to default
            localStorage.setItem('kb-theme', 'default');
            return 'default';
        }
        
        // Validate current theme exists
        if (savedTheme && !THEMES.find(t => t.id === savedTheme)) {
            localStorage.setItem('kb-theme', 'default');
            return 'default';
        }
        
        return savedTheme;
    } catch (e) {
        return null;
    }
}

/**
 * Initialize theme system
 */
function initThemeSystem() {
    // Migrate old themes
    migrateOldTheme();
    
    // Setup controls when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            populateThemeMenus();
            setupModeToggles();
        });
    } else {
        populateThemeMenus();
        setupModeToggles();
    }
}

// Initialize
initThemeSystem();

// Export for external use
window.KBTheme = {
    setTheme,
    setMode,
    toggleMode,
    getThemes: () => THEMES,
    getCurrentTheme: () => THEMES.find(t => t.id === document.documentElement.dataset.theme) || THEMES[0],
    getCurrentMode: () => document.documentElement.dataset.mode || 'dark'
};

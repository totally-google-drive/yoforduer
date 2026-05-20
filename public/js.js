// Escape HTML entities to prevent XSS
function escapeHtml(str) {
    if (typeof str !== 'string') return str;
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function copyLink() {
    navigator.clipboard.writeText("yoforduer.org").then(function() {
        var nameEl = document.querySelector('.mc-server-name');
        if (nameEl) {
            var originalText = nameEl.textContent;
            nameEl.textContent = "Copied!";
            nameEl.style.color = "#55aa55";
            setTimeout(function() {
                nameEl.textContent = originalText;
                nameEl.style.color = "#55ff55";
            }, 1500);
        }
    }).catch(function() {
        // Silently fail - clipboard API may be blocked
    });
}

async function fetchMCStatus() {
    try {
        const response = await fetch('/api/mc-status');
        if (!response.ok) throw new Error('HTTP ' + response.status);
        const data = await response.json();

        const playersText = document.getElementById('mc-players');
        const motdText = document.getElementById('mc-motd');
        const faviconImg = document.getElementById('mc-favicon');
        const playerCountEl = document.getElementById('mc-player-count');

        if (data.online) {
            if (playersText) {
                playersText.textContent = data.players + '/' + data.maxPlayers;
            }
            if (motdText) {
                motdText.textContent = data.motd || 'A Minecraft Server';
            }
            if (faviconImg && data.favicon) {
                faviconImg.src = data.favicon;
            }
            if (playerCountEl) {
                if (data.samplePlayers && data.samplePlayers.length > 0) {
                    const playerNames = data.samplePlayers.map(function(p) {
                        return escapeHtml(p.name || 'Unknown');
                    }).join(', ');
                    playerCountEl.title = 'Online: ' + playerNames;
                } else if (data.players > 0) {
                    playerCountEl.title = data.players + ' player(s) online';
                } else {
                    playerCountEl.title = 'No players online';
                }
            }
        } else {
            if (playersText) {
                playersText.textContent = '0/0';
            }
            if (motdText) {
                motdText.textContent = 'Server offline';
            }
            if (playerCountEl) {
                playerCountEl.title = 'Server offline';
            }
        }
    } catch (error) {
        console.error('MC Status error:', error);
    }
}

// Update current date
function updateDate() {
    const dateEl = document.getElementById('current-date');
    if (dateEl) {
        const now = new Date();
        dateEl.textContent = now.toLocaleDateString('en-US', {
            weekday: 'short',
            month: 'short',
            day: 'numeric'
        });
    }
}

// Wait for DOM to load before running initialization functions
document.addEventListener('DOMContentLoaded', function() {
    updateDate();
    fetchMCStatus();
    setInterval(fetchMCStatus, 30000);

    // Keyboard support for lightbox (Escape to close)
    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') {
            var lightbox = document.getElementById('lightbox');
            if (lightbox && lightbox.classList.contains('active')) {
                lightbox.classList.remove('active');
            }
        }
    });
});
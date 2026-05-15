function copyLink() {
    var dummy = document.createElement('input'),
    text = "yoforduer.org";

    document.body.appendChild(dummy);
    dummy.value = text;
    dummy.select();
    document.execCommand('copy');
    document.body.removeChild(dummy);

    var nameEl = document.querySelector('.mc-server-name');
    if (nameEl) {
        var originalText = nameEl.textContent;
        nameEl.textContent = "Copied!";
        nameEl.style.color = "#55aa55";
        setTimeout(function() {
            nameEl.textContent = originalText;
            nameEl.style.color = "#00aa00";
        }, 1500);
    }
}

async function fetchMCStatus() {
    try {
        const response = await fetch('/api/mc-status');
        const data = await response.json();

        const playersText = document.getElementById('mc-players');
        const motdText = document.getElementById('mc-motd');
        const faviconImg = document.getElementById('mc-favicon');
        const playerTooltipList = document.getElementById('player-tooltip-list');

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
            if (playerTooltipList) {
                if (data.samplePlayers && data.samplePlayers.length > 0) {
                    playerTooltipList.innerHTML = data.samplePlayers.map(function(p) {
                        return '<div class="mc-tooltip-player">' + (p.name || 'Unknown') + '</div>';
                    }).join('');
                } else {
                    playerTooltipList.innerHTML = '<div class="mc-tooltip-empty">No players online</div>';
                }
            }
        } else {
            if (playersText) {
                playersText.textContent = '0/0';
            }
            if (motdText) {
                motdText.textContent = 'Server offline';
            }
            if (playerTooltipList) {
                playerTooltipList.innerHTML = '<div class="mc-tooltip-empty">Server offline</div>';
            }
        }
    } catch (error) {
        console.error('MC Status error:', error);
    }
}

fetchMCStatus();
setInterval(fetchMCStatus, 30000);
// there is nothing worth looking for in here...

function copyLink() {
    var link = document.getElementById("link");
    var dummy = document.createElement('input'),
    text = "yoforduer.org";

    // stupid idiot dummy cause theres no api for the clipboard

    document.body.appendChild(dummy);
    dummy.value = text;
    dummy.select();
    document.execCommand('copy');
    document.body.removeChild(dummy);

    // delete the dummy cause i hate it

    link.innerHTML = "&nbsp;Link Copied!";
    setTimeout(function() {
        link.innerHTML = "yoforduer.org";
    }, 1500);
}
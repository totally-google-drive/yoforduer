function copyLink() {
    var text = document.getElementById("link");
    text.select();
    document.execCommand("copy");
}
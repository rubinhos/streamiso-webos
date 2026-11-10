// A modal question or error. It takes the focus while it is open and gives it back when it closes.
(function (S) {
  "use strict";

  var open = null;

  function close() {
    if (!open) return;
    var previous = open.previous;
    open = null;
    S.$("dialog").hidden = true;
    S.focus.restore(previous);
  }

  S.dialog = {
    isOpen: function () { return !!open; },
    // options: { title, text, buttons: [{ label, action }], onBack }. Without onBack, Back does nothing, for
    // the times when the viewer has to choose.
    show: function (options) {
      var previous = open ? open.previous : S.focus.state();
      open = { previous: previous, onBack: options.onBack };
      S.$("dialog-title").textContent = options.title;
      S.$("dialog-text").textContent = options.text || "";
      var row = S.$("dialog-buttons");
      row.innerHTML = "";
      options.buttons.forEach(function (b) {
        var button = document.createElement("button");
        button.type = "button";
        button.className = "btn";
        button.tabIndex = -1;
        button.setAttribute("data-focusable", "");
        button.textContent = b.label;
        button.addEventListener("click", function () {
          close();
          if (b.action) b.action();
        });
        row.appendChild(button);
      });
      S.$("dialog").hidden = false;
      S.focus.setScope(S.$("dialog"));
    },
    close: close,
    handleKey: function (name) {
      if (name === "left" || name === "right" || name === "up" || name === "down") S.focus.move(name);
      else if (name === "enter") S.focus.activate();
      else if (name === "back" && open.onBack) {
        var onBack = open.onBack;
        close();
        onBack();
      }
    }
  };
})(window.Streamiso);

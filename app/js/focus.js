// The focus manager. One "scope" (a screen, a dialog, the player's bar) is active at a time. The focus stays
// on a [data-focusable] inside it, moves by screen position, and comes back if anything takes it away.
(function (S) {
  "use strict";

  var scope = null;
  var last = null;
  var locked = false;  // a text field is being edited, so its keys belong to the on-screen keyboard
  var MARGIN = 40;

  function isVisible(el) {
    var rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function candidates() {
    if (!scope) return [];
    var list = scope.hasAttribute("data-focusable") ? [scope] : [];
    return list.concat(Array.prototype.slice.call(scope.querySelectorAll("[data-focusable]")).filter(isVisible));
  }

  // Picks the best rectangle in a direction, or -1. The nearest row or column wins first, then the one most
  // in line: pressing Down reaches the card right below, not a closer one off to the side.
  function pick(from, rects, direction) {
    var best = -1, bestScore = Infinity;
    var vertical = direction === "up" || direction === "down";
    var sign = direction === "down" || direction === "right" ? 1 : -1;
    rects.forEach(function (r, i) {
      var gap = sign > 0
        ? (vertical ? r.top - from.bottom : r.left - from.right)
        : (vertical ? from.top - r.bottom : from.left - r.right);
      // Rectangles may overlap a little, so a small negative gap still counts as "in that direction".
      if (gap < -8) return;
      var overlap = vertical
        ? Math.min(from.right, r.right) - Math.max(from.left, r.left)
        : Math.min(from.bottom, r.bottom) - Math.max(from.top, r.top);
      // Left and Right never leave the row, so the end of a row is the end of the movement.
      if (!vertical && overlap <= 0) return;
      var fromCenter = vertical ? (from.left + from.right) / 2 : (from.top + from.bottom) / 2;
      var center = vertical ? (r.left + r.right) / 2 : (r.top + r.bottom) / 2;
      var score = Math.max(gap, 0) * 4 + Math.abs(center - fromCenter) + (overlap > 0 ? 0 : 2000);
      if (score < bestScore) { bestScore = score; best = i; }
    });
    return best;
  }

  // Scrolls the nearest [data-scroll] box just enough to show the element, with the section title above the
  // first row when there is one.
  function reveal(el) {
    var box = el.parentElement;
    while (box && !box.hasAttribute("data-scroll")) box = box.parentElement;
    if (!box) return;
    var r = el.getBoundingClientRect();
    var b = box.getBoundingClientRect();
    if (r.top < b.top + MARGIN) box.scrollTop -= b.top + MARGIN - r.top;
    else if (r.bottom > b.bottom - MARGIN) box.scrollTop += r.bottom - (b.bottom - MARGIN);
    var section = el.parentElement && el.parentElement.previousElementSibling;
    if (section && section.classList.contains("section-title") && el.parentElement.firstElementChild === el) {
      var top = section.getBoundingClientRect().top;
      if (top < b.top) box.scrollTop -= b.top - top;
    }
  }

  function place(el) {
    last = el;
    el.focus({ preventScroll: true });
    reveal(el);
  }

  // Brings the focus back if it left the scope, for example into the video's iframe.
  function ensure() {
    if (locked || !scope) return;
    var active = document.activeElement;
    var list = candidates();
    if (active && list.indexOf(active) >= 0) return;
    if (active && active.tagName === "IFRAME") active.blur();
    try { window.focus(); } catch (e) { /* fine */ }
    var target = last && list.indexOf(last) >= 0 ? last : list[0];
    if (target) place(target);
  }

  S.focus = {
    pick: pick,
    ensure: ensure,
    // Makes a scope active, focusing target if given, otherwise the first thing in it.
    setScope: function (el, target) {
      scope = el;
      last = null;
      if (target) place(target);
      else ensure();
    },
    scope: function () { return scope; },
    state: function () { return { scope: scope, active: last }; },
    restore: function (state) {
      scope = state.scope;
      last = state.active;
      ensure();
    },
    focus: function (el) { if (candidates().indexOf(el) >= 0) place(el); },
    // Returns true if the focus moved.
    move: function (direction) {
      ensure();
      var list = candidates();
      var current = document.activeElement;
      var others = list.filter(function (el) { return el !== current; });
      var index = pick(current.getBoundingClientRect(), others.map(function (el) { return el.getBoundingClientRect(); }), direction);
      if (index < 0) return false;
      place(others[index]);
      return true;
    },
    activate: function () {
      ensure();
      if (document.activeElement) document.activeElement.click();
    },
    lock: function (on) { locked = on; },
    isLocked: function () { return locked; },
    // The video's page asks for the focus again and again as it starts. Taking it back whenever the app's
    // window loses it, plus a slow check for anything that slips through, keeps the keys with the app.
    guard: function () {
      window.addEventListener("blur", function () { setTimeout(ensure, 0); });
      setInterval(ensure, 500);
    }
  };
})(window.Streamiso);

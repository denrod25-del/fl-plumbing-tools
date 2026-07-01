/* FL Plumbing Tools — Premium Enhancement Module (Elite Phase B)
   Vanilla JS, no dependencies, loaded with defer. Namespaced elb-.
   DECOUPLED: reads only its own data-elb-* attributes and localStorage.
   It never reads or depends on any calculator's result DOM. */
(function () {
  "use strict";
  var KEY = "flpt_saved";

  function readSaved() {
    try { var v = JSON.parse(localStorage.getItem(KEY) || "[]"); return Array.isArray(v) ? v : []; }
    catch (e) { return []; }
  }
  function writeSaved(list) {
    try { localStorage.setItem(KEY, JSON.stringify(list)); return true; } catch (e) { return false; }
  }
  function isSaved(list, url) { for (var i = 0; i < list.length; i++) { if (list[i] && list[i].url === url) return true; } return false; }

  var toastEl = null, toastT = null;
  function toast(msg) {
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.className = "elb-toast";
      toastEl.setAttribute("role", "status");
      toastEl.setAttribute("aria-live", "polite");
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    // force reflow so the transition runs
    void toastEl.offsetWidth;
    toastEl.classList.add("elb-show");
    if (toastT) clearTimeout(toastT);
    toastT = setTimeout(function () { toastEl.classList.remove("elb-show"); }, 2200);
  }

  function ready(fn) {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fn);
    else fn();
  }

  ready(function () {
    var saveBtn = document.querySelector(".elb-save");
    var savedPanel = document.getElementById("elb-saved");

    // ---- Save this tool ----
    if (saveBtn) {
      var slug = saveBtn.getAttribute("data-elb-slug") || "";
      var title = saveBtn.getAttribute("data-elb-title") || document.title;
      var url = saveBtn.getAttribute("data-elb-url") || location.pathname;

      var syncBtn = function () {
        var on = isSaved(readSaved(), url);
        saveBtn.setAttribute("aria-pressed", on ? "true" : "false");
        saveBtn.querySelector(".elb-label").textContent = on ? "Saved ✓" : "Save this tool";
      };
      syncBtn();

      saveBtn.addEventListener("click", function () {
        var list = readSaved();
        if (isSaved(list, url)) {
          list = list.filter(function (x) { return x.url !== url; });
          writeSaved(list); syncBtn(); renderSaved(); toast("Removed from saved tools");
        } else {
          list.push({ slug: slug, title: title, url: url, timestamp: Date.now() });
          writeSaved(list); syncBtn(); renderSaved(); toast("Saved — view your saved tools below");
        }
      });
    }

    // ---- Saved list viewer (built here so per-page HTML stays tiny) ----
    function renderSaved() {
      if (!savedPanel) return;
      var list = readSaved().slice().sort(function (a, b) { return (b.timestamp || 0) - (a.timestamp || 0); });
      var html = '<h3>Your saved tools</h3>';
      if (!list.length) {
        html += '<p class="elb-empty">Nothing saved yet. Use “Save this tool” to keep a shortcut here (stored only in this browser).</p>';
      } else {
        html += "<ul>";
        for (var i = 0; i < list.length; i++) {
          var it = list[i];
          var t = (it.title || it.slug || it.url).replace(/[<>&]/g, "");
          html += '<li><a href="' + it.url + '">' + t + '</a>' +
                  '<button type="button" class="elb-rm" data-url="' + it.url + '" aria-label="Remove ' + t + '">×</button></li>';
        }
        html += "</ul>";
      }
      savedPanel.innerHTML = html;
      var rm = savedPanel.querySelectorAll(".elb-rm");
      for (var j = 0; j < rm.length; j++) {
        rm[j].addEventListener("click", function () {
          var u = this.getAttribute("data-url");
          writeSaved(readSaved().filter(function (x) { return x.url !== u; }));
          renderSaved();
          if (saveBtn && (saveBtn.getAttribute("data-elb-url") === u)) {
            saveBtn.setAttribute("aria-pressed", "false");
            saveBtn.querySelector(".elb-label").textContent = "Save this tool";
          }
          toast("Removed from saved tools");
        });
      }
    }

    var viewBtn = document.querySelector(".elb-viewsaved");
    if (viewBtn && savedPanel) {
      savedPanel.hidden = true;
      viewBtn.setAttribute("aria-expanded", "false");
      viewBtn.setAttribute("aria-controls", "elb-saved");
      viewBtn.addEventListener("click", function () {
        var open = savedPanel.hidden;
        savedPanel.hidden = !open;
        viewBtn.setAttribute("aria-expanded", open ? "true" : "false");
        if (open) { renderSaved(); savedPanel.scrollIntoView({ block: "nearest" }); }
      });
      renderSaved();
    }

    // ---- Download / Print report ----
    var printBtn = document.querySelector(".elb-print");
    if (printBtn) {
      printBtn.addEventListener("click", function () {
        if (savedPanel) savedPanel.hidden = true;
        window.print();
      });
    }
  });
})();

// Analytics, with an owner kill switch: visiting any page with ?notrack=1
// silences the analytics tags (?notrack=0 clears it). The flag is a cookie
// scoped to .milestomorrow.com, so one visit covers every site on the domain.
// localStorage is still read, so per-origin opt-outs made before this keep
// working, and still written for hosts a domain cookie cannot reach.
//
// The other eight sites carry this block inline. It lives in its own file here
// because this app sends `script-src 'self'`, which refuses an inline script —
// so the gate never ran and this site reported nothing to GA at all. The
// measurement ID comes from the script tag so the page still declares which
// property it feeds.
(function () {
  var KEY = "mt-notrack";
  var tag = document.currentScript;
  var ID = (tag && tag.getAttribute("data-ga")) || "";
  try {
    var q = new URLSearchParams(location.search);
    if (q.has("notrack")) {
      var off = q.get("notrack") === "0";
      document.cookie =
        KEY + "=" + (off ? "" : "1") +
        ";domain=.milestomorrow.com;path=/;max-age=" + (off ? 0 : 315360000) +
        ";samesite=lax" + (location.protocol === "https:" ? ";secure" : "");
      off ? localStorage.removeItem(KEY) : localStorage.setItem(KEY, "1");
    }
    if (document.cookie.indexOf(KEY + "=1") > -1) return;
    if (localStorage.getItem(KEY)) return;
  } catch (e) {}
  if (!ID) return;
  var g = document.createElement("script");
  g.async = true;
  g.src = "https://www.googletagmanager.com/gtag/js?id=" + ID;
  document.head.appendChild(g);
  window.dataLayer = window.dataLayer || [];
  window.gtag = function () { dataLayer.push(arguments); };
  gtag("js", new Date());
  gtag("config", ID);
})();

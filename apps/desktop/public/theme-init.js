// Aplica o tema antes do 1º paint (evita flash). Mantenha em sincronia com
// packages/ui/src/theme.ts (mesma chave e mesmo padrão "dark").
(function () {
  var preference = "dark";
  try {
    var stored = localStorage.getItem("aurora.theme");
    if (stored === "dark" || stored === "light" || stored === "system") preference = stored;
  } catch (e) {
    // armazenamento bloqueado: mantém o padrão
  }
  var systemDark = !window.matchMedia || window.matchMedia("(prefers-color-scheme: dark)").matches;
  var dark = preference === "dark" || (preference === "system" && systemDark);
  document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
})();

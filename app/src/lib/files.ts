/** Lecture d'un fichier choisi par l'utilisateur (taille plafonnée) et export par téléchargement. */
export function pickTextFile(accept = ".json", maxBytes = 64_000): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return resolve(undefined);
      if (f.size > maxBytes) return reject(new Error(`fichier trop gros (${Math.round(f.size / 1024)} Ko, max ${maxBytes / 1000} Ko)`));
      resolve(await f.text());
    };
    input.click();
  });
}

export function downloadText(filename: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.dataset.download = "1";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

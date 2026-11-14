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

/** Lecture de plusieurs fichiers texte choisis par l'utilisateur (un script et ses modules), taille plafonnée. */
export function pickTextFiles(accept: string, maxFiles: number, maxBytes: number): Promise<{ name: string; content: string }[] | undefined> {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.multiple = true;
    input.onchange = async () => {
      const files = [...(input.files ?? [])];
      if (!files.length) return resolve(undefined);
      if (files.length > maxFiles) return reject(new Error(`trop de fichiers (${files.length}, max ${maxFiles})`));
      const big = files.find((f) => f.size > maxBytes);
      if (big) return reject(new Error(`${big.name} est trop gros (${Math.round(big.size / 1024)} Ko, max ${maxBytes / 1000} Ko)`));
      resolve(await Promise.all(files.map(async (f) => ({ name: f.name, content: await f.text() }))));
    };
    input.click();
  });
}

/**
 * Choisit une image et la recadre en carré (centre), réduite à `size` px, encodée en WebP.
 * Le recadrage passe par un canvas : seuls des pixels ressortent (pas de métadonnées EXIF, pas de SVG).
 */
export function pickAvatar(size = 256): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/png,image/jpeg,image/webp";
    input.onchange = () => {
      const f = input.files?.[0];
      if (!f) return resolve(undefined);
      if (!/^image\/(png|jpeg|webp)$/.test(f.type)) return reject(new Error("image PNG, JPEG ou WebP attendue"));
      if (f.size > 15 * 1024 * 1024) return reject(new Error("image trop lourde (15 Mo max)"));
      const url = URL.createObjectURL(f);
      const img = new Image();
      img.onload = () => {
        const side = Math.min(img.naturalWidth, img.naturalHeight);
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = Math.min(size, side);
        const ctx = canvas.getContext("2d")!;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, canvas.width, canvas.height);
        URL.revokeObjectURL(url);
        let data = canvas.toDataURL("image/webp", 0.86);
        if (!data.startsWith("data:image/webp")) data = canvas.toDataURL("image/jpeg", 0.86);
        resolve(data);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("image illisible"));
      };
      img.src = url;
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

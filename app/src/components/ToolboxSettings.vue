<script setup lang="ts">
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { ClipboardCopy, Download, FileCog, FolderOpen, PackagePlus, RotateCw, ShieldAlert, Wrench } from "lucide-vue-next";
import { computed, onMounted, ref } from "vue";
import { call } from "../lib/rpc";
import { toast } from "../lib/store";
import ModalBox from "./ModalBox.vue";
import SettingRow from "./SettingRow.vue";

/**
 * Paramètres > Boîte à outils : liste des outils (tools/), convention à donner à une IA pour en écrire un nouveau,
 * import d'un dossier manifest.json + tool.py. L'import montre d'abord ce que demande l'outil (risque, permissions) :
 * rien n'est copié sans l'accord de l'utilisateur. Les agents n'ont pas accès à ces actions.
 */

interface ToolParam {
  type?: string;
  required?: boolean;
  description?: string;
}
interface ToolEntry {
  name: string;
  category: string;
  description: string;
  risk: string;
  enabled: boolean;
  permissions: string[];
}
interface ImportInfo {
  name: string;
  version?: string;
  category?: string;
  description: string;
  risk: string;
  permissions: string[];
  missing_permissions: string[];
  parameters: Record<string, ToolParam>;
  destination: string;
  /** Empreinte du contenu montré : renvoyée avec l'accord, refusée si le dossier a changé entre-temps. */
  digest: string;
  /** Code de tool.py, montré avant l'accord. */
  source: string;
}

const RISK_LABEL: Record<string, string> = {
  read: "lecture",
  launch: "lancement",
  local: "confirmé",
  external: "externe, confirmé",
};

interface SetupInfo {
  dir: string;
  present: boolean;
  policy: boolean;
  defaultDir: string;
  python: { command: string; version: string } | null;
  pillow: string | null;
}

const setup = ref<SetupInfo | null>(null);
const installingDeps = ref(false);

async function loadSetup() {
  try {
    setup.value = await call<SetupInfo>("toolbox.setup", {}, 30_000);
  } catch {
    setup.value = null;
  }
}

async function installDeps() {
  installingDeps.value = true;
  try {
    await call("toolbox.installDeps", {}, 620_000);
    toast("Pillow installé : les outils d'images sont prêts", "success");
    await Promise.all([loadSetup(), load()]);
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    installingDeps.value = false;
  }
}

async function openDefaultDir() {
  try {
    await call("toolbox.openDefaultDir");
  } catch (e) {
    toast((e as Error).message, "error");
  }
}

const tools = ref<ToolEntry[]>([]);
const problems = ref<string[]>([]);
const error = ref("");
const loading = ref(false);
const filter = ref("");
const pending = ref<{ dir: string; info: ImportInfo; warnings: string[] } | null>(null);
const importing = ref(false);

const shown = computed(() => {
  const q = filter.value.trim().toLowerCase();
  const list = q ? tools.value.filter((t) => `${t.name} ${t.category} ${t.description}`.toLowerCase().includes(q)) : tools.value;
  return [...list].sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
});

async function load() {
  loading.value = true;
  error.value = "";
  try {
    const r = await call<{ tools: ToolEntry[]; problems: string[] }>("toolbox.list");
    tools.value = r.tools;
    problems.value = r.problems;
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}

async function copyConvention() {
  try {
    const text = await call<string>("toolbox.convention");
    await navigator.clipboard.writeText(
      `${text}\n\n---\nL'outil dont j'ai besoin : (décris-le ici, ex. « un outil qui crée des cubes dans Blender »)\n`,
    );
    toast("Convention copiée : colle-la à une IA avec ta demande", "success");
  } catch (e) {
    toast((e as Error).message, "error");
  }
}

async function pickImport() {
  const dir = await openDialog({ directory: true, multiple: false, title: "Dossier de l'outil (manifest.json + tool.py)" });
  if (typeof dir !== "string") return;
  try {
    const r = await call<{ imported: boolean; tool: ImportInfo; warnings: string[] }>("toolbox.import", { dir, confirmed: false });
    pending.value = { dir, info: r.tool, warnings: r.warnings };
  } catch (e) {
    toast((e as Error).message, "error");
  }
}

async function confirmImport() {
  if (!pending.value) return;
  importing.value = true;
  try {
    const r = await call<{ imported: boolean; tool: ImportInfo; warnings: string[] }>("toolbox.import", {
      dir: pending.value.dir,
      confirmed: true,
      digest: pending.value.info.digest,
    });
    toast(`Outil « ${r.tool.name} » importé${r.warnings.length ? " (désactivé : permission à accorder)" : ""}`, "success");
    pending.value = null;
    await load();
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    importing.value = false;
  }
}

async function openPolicy() {
  try {
    await call("config.openFile", { file: "policy" });
  } catch (e) {
    toast((e as Error).message, "error");
  }
}

onMounted(() => {
  void load();
  void loadSetup();
});
</script>

<template>
  <section class="card">
    <h3 class="sec-title">Boîte à outils</h3>
    <div v-if="setup" class="tb-setup small">
      <div class="tb-check">
        <span class="badge" :class="setup.present ? 'ok' : 'warn'">{{ setup.present ? "installée" : "absente" }}</span>
        <span>Outils dans <code>{{ setup.dir }}</code></span>
      </div>
      <div class="tb-check">
        <span class="badge" :class="setup.python ? 'ok' : 'warn'">{{ setup.python ? `Python ${setup.python.version}` : "Python manquant" }}</span>
        <span v-if="setup.python">lancé par <code>{{ setup.python.command }}</code></span>
        <span v-else>Installe Python 3 depuis <a href="https://www.python.org/downloads/">python.org ↗</a> (coche « Add python.exe to PATH »), puis actualise.</span>
      </div>
      <div v-if="setup.python" class="tb-check">
        <span class="badge" :class="setup.pillow ? 'ok' : 'warn'">{{ setup.pillow ? `Pillow ${setup.pillow}` : "Pillow manquant" }}</span>
        <span v-if="setup.pillow">outils d'images et de textures prêts</span>
        <template v-else>
          <span>nécessaire aux outils d'images et de textures</span>
          <button class="btn sm primary" :disabled="installingDeps" @click="installDeps"><Download :size="14" /> {{ installingDeps ? "Installation…" : "Installer" }}</button>
        </template>
      </div>
      <div class="tb-check">
        <span class="badge" :class="setup.policy ? 'ok' : 'warn'">{{ setup.policy ? "dossier prêt" : "pas de politique" }}</span>
        <span>Dossier de travail des outils : <code>{{ setup.defaultDir }}</code></span>
        <button class="btn sm ghost" @click="openDefaultDir"><FolderOpen :size="14" /> Ouvrir</button>
      </div>
      <p class="tiny muted">
        Mets dans ce dossier les images, textures ou fichiers que les agents doivent traiter. Pour d'autres dossiers (tes projets), ajoute-les
        dans policy.json ; chaque écriture te sera demandée.
      </p>
    </div>
    <SettingRow
      label="Ajouter un outil"
      hint="Copie la convention, donne-la à une IA avec ta demande (« un outil qui crée des cubes dans Blender »), range ses deux fichiers dans un dossier au nom de l'outil, puis importe ce dossier."
    >
      <div class="row">
        <button class="btn sm" @click="copyConvention"><ClipboardCopy :size="14" /> Copier la convention</button>
        <button class="btn sm primary" @click="pickImport"><PackagePlus :size="14" /> Importer un outil…</button>
      </div>
    </SettingRow>
    <SettingRow label="Permissions et dossiers" hint="tools/policy.json : ce que les outils ont le droit de lancer et les dossiers qu'ils peuvent lire ou écrire.">
      <button class="btn sm" @click="openPolicy"><FileCog :size="14" /> Ouvrir policy.json</button>
    </SettingRow>

    <div class="tb-head">
      <input v-model="filter" class="input tb-filter" placeholder="Filtrer les outils…" />
      <span class="tiny muted">{{ tools.length }} outils</span>
      <button class="btn sm ghost icon" title="Actualiser" :disabled="loading" @click="load(); loadSetup()"><RotateCw :size="14" /></button>
    </div>
    <p v-if="error" class="small warn-text">{{ error }}</p>
    <ul v-else class="tb-list">
      <li v-for="t in shown" :key="t.name" :class="{ off: !t.enabled }">
        <div class="tb-line">
          <Wrench :size="13" />
          <code>{{ t.name }}</code>
          <span class="tiny muted">{{ t.category }}</span>
          <span class="badge" :class="t.risk === 'read' ? 'ok' : 'warn'">{{ RISK_LABEL[t.risk] ?? t.risk }}</span>
          <span v-if="!t.enabled" class="badge" :title="`Permission à accorder dans policy.json : ${t.permissions.join(', ')}`">désactivé</span>
        </div>
        <p class="tiny muted">{{ t.description }}</p>
      </li>
    </ul>
    <p v-for="p in problems" :key="p" class="tiny warn-text">{{ p }}</p>

    <ModalBox v-if="pending" :title="`Importer « ${pending.info.name} » ?`" wide @close="pending = null">
      <template #icon><ShieldAlert :size="20" /></template>
      <p class="small">{{ pending.info.description }}</p>
      <dl class="tb-facts small">
        <dt>Risque</dt>
        <dd>{{ RISK_LABEL[pending.info.risk] ?? pending.info.risk }}</dd>
        <dt>Permissions</dt>
        <dd>{{ pending.info.permissions.join(", ") || "aucune" }}</dd>
        <dt>Paramètres</dt>
        <dd>
          <div v-for="(p, k) in pending.info.parameters" :key="k">
            <code>{{ k }}</code> <span class="muted">({{ p.type ?? "string" }}{{ p.required ? ", obligatoire" : "" }})</span>
            {{ p.description }}
          </div>
          <span v-if="!Object.keys(pending.info.parameters).length" class="muted">aucun</span>
        </dd>
        <dt>Copié dans</dt>
        <dd><code>{{ pending.info.destination }}</code></dd>
      </dl>
      <details class="tb-source">
        <summary class="small">Code de tool.py ({{ pending.info.source.split("\n").length }} lignes)</summary>
        <pre><code>{{ pending.info.source }}</code></pre>
      </details>
      <p class="small">Outil importé : chaque exécution te sera demandée, quel que soit le risque qu'il déclare.</p>
      <p v-for="w in pending.warnings" :key="w" class="small warn-text">{{ w }}</p>
      <p class="tiny muted">
        L'outil exécutera son code Python sur ce PC quand un agent l'utilisera. N'importe que du code dont tu connais l'origine, et
        relis tool.py si l'outil écrit des fichiers ou lance des programmes.
      </p>
      <template #actions>
        <button class="btn sm" @click="pending = null">Annuler</button>
        <button class="btn sm primary" :disabled="importing" @click="confirmImport"><PackagePlus :size="14" /> Importer</button>
      </template>
    </ModalBox>
  </section>
</template>

<style scoped>
.tb-setup {
  display: grid;
  gap: 8px;
  margin: 4px 0 14px;
  padding: 12px;
  border-radius: var(--radius-sm);
  background: var(--surface-2);
}
.tb-check {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.tb-check code {
  overflow-wrap: anywhere;
}
.tb-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 14px 0 8px;
}
.tb-filter {
  flex: 1;
}
.tb-list {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 420px;
  overflow-y: auto;
}
.tb-list li {
  padding: 6px 2px;
  border-bottom: 1px solid var(--hairline);
}
.tb-list li.off {
  opacity: 0.6;
}
.tb-list p {
  margin: 2px 0 0 21px;
}
.tb-line {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.tb-facts {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 6px 14px;
  margin: 12px 0;
}
.tb-facts dt {
  font-weight: 600;
}
.tb-facts dd {
  margin: 0;
  overflow-wrap: anywhere;
}
.tb-source pre {
  max-height: 320px;
  overflow: auto;
  padding: 10px;
  border-radius: var(--radius-sm);
  background: var(--surface-2);
  font-family: var(--mono);
  font-size: 12px;
}
.warn-text {
  color: var(--warning);
}
</style>

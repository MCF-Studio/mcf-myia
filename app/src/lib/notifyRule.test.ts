// Tests de la décision de notification. Lancés par `npm test` (node --test, types retirés par Node).
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { shouldNotify, type NotifySettings, type ScreenState, type WindowState } from "./notifyRule.ts";

const CONV = "c1";
const premierPlan: WindowState = { focused: true, minimized: false, visible: true };
const surLaConv: ScreenState = { view: "conversations", layout: "tabs", activeTab: CONV, openTabs: [CONV, "c2"] };
// Réglage « seulement si pas au premier plan » coupé : c'est là que le défaut se voyait le plus.
const toujours: NotifySettings = { desktop: true, onlyWhenUnfocused: false };
const siPasAuPremierPlan: NotifySettings = { desktop: true, onlyWhenUnfocused: true };

describe("shouldNotify", () => {
  it("fenêtre au premier plan et conversation affichée : pas de notification", () => {
    assert.equal(shouldNotify(CONV, premierPlan, surLaConv, toujours), false);
    assert.equal(shouldNotify(CONV, premierPlan, surLaConv, siPasAuPremierPlan), false);
  });

  it("mode grille : la conversation visible dans la grille ne notifie pas", () => {
    const grille: ScreenState = { ...surLaConv, layout: "grid", activeTab: "c2" };
    assert.equal(shouldNotify(CONV, premierPlan, grille, toujours), false);
  });

  it("fenêtre réduite : notification", () => {
    const reduite: WindowState = { ...premierPlan, minimized: true };
    assert.equal(shouldNotify(CONV, reduite, surLaConv, toujours), true);
    assert.equal(shouldNotify(CONV, reduite, surLaConv, siPasAuPremierPlan), true);
  });

  it("fenêtre cachée (zone de notification) : notification", () => {
    const cachee: WindowState = { ...premierPlan, visible: false };
    assert.equal(shouldNotify(CONV, cachee, surLaConv, siPasAuPremierPlan), true);
  });

  it("fenêtre sans focus (en arrière-plan) : notification", () => {
    const sansFocus: WindowState = { ...premierPlan, focused: false };
    assert.equal(shouldNotify(CONV, sansFocus, surLaConv, toujours), true);
    assert.equal(shouldNotify(CONV, sansFocus, surLaConv, siPasAuPremierPlan), true);
  });

  it("autre conversation affichée : notification si le réglage le permet", () => {
    const autre: ScreenState = { ...surLaConv, activeTab: "c2" };
    assert.equal(shouldNotify(CONV, premierPlan, autre, toujours), true);
    // Comme avant : « seulement si pas au premier plan » bloque quand la fenêtre a le focus.
    assert.equal(shouldNotify(CONV, premierPlan, autre, siPasAuPremierPlan), false);
  });

  it("autre page ouverte : notification si le réglage le permet", () => {
    const autrePage: ScreenState = { ...surLaConv, view: "agents" };
    assert.equal(shouldNotify(CONV, premierPlan, autrePage, toujours), true);
    assert.equal(shouldNotify(CONV, premierPlan, autrePage, siPasAuPremierPlan), false);
  });

  it("notifications du bureau coupées : jamais", () => {
    const off: NotifySettings = { desktop: false, onlyWhenUnfocused: false };
    assert.equal(shouldNotify(CONV, { ...premierPlan, focused: false }, surLaConv, off), false);
  });
});

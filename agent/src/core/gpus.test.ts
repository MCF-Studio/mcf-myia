import { describe, expect, it } from "vitest";
import { parseConfig } from "./config.js";
import { llamaGpuArgs, ollamaGpuEnv, parseLlamaDevices, parseNvidiaSmi, type GpuSetting } from "./gpus.js";

const LIST = `ggml_cuda_init: found 2 CUDA devices:
Available devices:
  CUDA0: NVIDIA GeForce RTX 3060 Ti (8191 MiB, 7140 MiB free)
  CUDA1: NVIDIA GeForce RTX 3060 (12287 MiB, 12000 MiB free)
`;
const SMI = `0, GPU-d3c3342f-ca83-4ba5-633f-74f0fc035d90, NVIDIA GeForce RTX 3060 Ti, 8192
1, GPU-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee, NVIDIA GeForce RTX 3060, 12288
`;
const base: GpuSetting = { mode: "auto", splitMode: "layer" };

describe("plusieurs cartes graphiques", () => {
  it("lit la liste de llama.cpp et celle de nvidia-smi", () => {
    expect(parseLlamaDevices(LIST)).toEqual([
      { device: "CUDA0", name: "NVIDIA GeForce RTX 3060 Ti", memoryMb: 8191 },
      { device: "CUDA1", name: "NVIDIA GeForce RTX 3060", memoryMb: 12287 },
    ]);
    expect(parseNvidiaSmi(SMI).map((g) => g.uuid)).toEqual(["GPU-d3c3342f-ca83-4ba5-633f-74f0fc035d90", "GPU-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"]);
    expect(parseLlamaDevices("rien\n")).toEqual([]);
    expect(parseNvidiaSmi("'nvidia-smi' n'est pas reconnu")).toEqual([]);
  });

  it("llama.cpp : rien en auto, une carte, ou répartition avec parts", () => {
    expect(llamaGpuArgs(base)).toEqual([]);
    expect(llamaGpuArgs({ ...base, mode: "single", device: "CUDA1" })).toEqual(["--device", "CUDA1", "--split-mode", "none"]);
    expect(llamaGpuArgs({ ...base, mode: "single" })).toEqual([]); // aucune carte choisie : le moteur décide
    expect(llamaGpuArgs({ ...base, mode: "split" })).toEqual(["--split-mode", "layer"]);
    expect(llamaGpuArgs({ ...base, mode: "split", splitMode: "row", ratios: [3, 1] })).toEqual(["--split-mode", "row", "--tensor-split", "3,1"]);
  });

  it("Ollama : variables posées seulement si Windows ne les fixe pas déjà", () => {
    const uuid = "GPU-d3c3342f-ca83-4ba5-633f-74f0fc035d90";
    expect(ollamaGpuEnv(base, {})).toEqual({});
    expect(ollamaGpuEnv({ ...base, mode: "single", uuid }, {})).toEqual({ CUDA_VISIBLE_DEVICES: uuid });
    expect(ollamaGpuEnv({ ...base, mode: "single", uuid }, { CUDA_VISIBLE_DEVICES: "0" })).toEqual({});
    expect(ollamaGpuEnv({ ...base, mode: "split" }, {})).toEqual({ OLLAMA_SCHED_SPREAD: "1" });
  });

  it("configuration : auto par défaut, nom de carte contrôlé (jamais un argument injecté)", () => {
    expect(parseConfig({}).llm.gpu).toEqual({ mode: "auto", splitMode: "layer" });
    expect(() => parseConfig({ llm: { gpu: { mode: "single", device: "CUDA0 --host 0.0.0.0" } } })).toThrow();
    expect(parseConfig({ llm: { gpu: { mode: "single", device: "Vulkan1" } } }).llm.gpu.device).toBe("Vulkan1");
  });
});

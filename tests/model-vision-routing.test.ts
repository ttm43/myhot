// Which models a step may use (admin) reads the step's vision flag.
import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb } from "@aihot/backend/db";
import { modelsOverview, switchModel } from "@aihot/backend/admin/models";
import { CAPABILITIES, capabilityAcceptsModel, modelFor } from "@aihot/backend/editorial/models";
import { MODELS } from "@aihot/backend/providers/llm";

after(closeDb);

test("every step takes a model that reads images; only a step that needs images refuses a text model", async () => {
  const structure = CAPABILITIES.structure;
  assert.equal(capabilityAcceptsModel(structure, MODELS["glm-5.3-flash"]!), true);
  assert.equal(capabilityAcceptsModel(structure, MODELS["qwen3-vl-flash"]!), true);
  assert.equal(capabilityAcceptsModel(structure, MODELS["deepseek-flash"]!), true);
  assert.equal(capabilityAcceptsModel({ ...structure, vision: true }, MODELS["deepseek-flash"]!), false);

  await switchModel("structure", "qwen3-vl-flash", "vision routing test", "test");
  assert.equal(await modelFor("structure"), "qwen3-vl-flash");
  await switchModel("structure", "deepseek-flash", "text routing test", "test");
  assert.equal(await modelFor("structure"), "deepseek-flash");

  const overview = await modelsOverview(1);
  assert.equal(overview.capabilities.find((capability) => capability.key === "structure")?.vision, false);
});

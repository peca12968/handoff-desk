import { expect } from "@playwright/test";

const keys = new Set(["Tab", "Shift+Tab", "Enter", "Escape", "Space", "ArrowLeft", "ArrowRight",
  "ArrowUp", "ArrowDown", "Home", "End"]);

export function validate(flow) {
  if (!flow || typeof flow.page !== "string" || !flow.page.trim() ||
      !Array.isArray(flow.steps) || !flow.steps.length) {
    throw new Error("Expected a page and a nonempty steps array");
  }
  for (const [index, step] of flow.steps.entries()) {
    if (!keys.has(step?.key) || typeof step.role !== "string" || !step.role.trim() ||
        typeof step.name !== "string" || !step.name.trim()) {
      throw new Error("Invalid key, role or accessible name at step " + (index + 1));
    }
  }
}

function activeNode(page) {
  return page.evaluate(() => {
    let node = document.activeElement;
    while (node?.shadowRoot?.activeElement) node = node.shadowRoot.activeElement;
    return node ? { tag: node.localName, id: node.id || null } : null;
  });
}

export async function replay(page, steps, timeout = 2000) {
  const checks = [];
  for (const [index, step] of steps.entries()) {
    await page.keyboard.press(step.key);
    const target = page.getByRole(step.role, { name: step.name, exact: true });
    const check = { step: index + 1, key: step.key, expected: { role: step.role, name: step.name } };
    try {
      await expect(target).toBeFocused({ timeout });
    } catch (error) {
      if (page.isClosed()) throw error;
      const matches = await target.count();
      const reason = matches === 0 ? "missing-target" : matches > 1 ? "ambiguous-target" : "wrong-focus";
      checks.push({ ...check, passed: false, reason, matches, active: await activeNode(page) });
      return { passed: false, planned: steps.length, checks };
    }
    checks.push({ ...check, passed: true, active: await activeNode(page) });
  }
  return { passed: true, planned: steps.length, checks };
}

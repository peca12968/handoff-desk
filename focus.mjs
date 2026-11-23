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
    if (step.frames !== undefined && (!Array.isArray(step.frames) ||
        step.frames.some(title => typeof title !== "string" || !title.trim()))) {
      throw new Error("Expected a list of iframe titles at step " + (index + 1));
    }
  }
}

async function activeNode(page) {
  const frames = [];
  let frame = page.mainFrame();
  while (frame) {
    const handle = await frame.evaluateHandle(() => {
      let node = document.activeElement;
      while (node?.shadowRoot?.activeElement) node = node.shadowRoot.activeElement;
      return node;
    });
    try {
      const element = handle.asElement();
      if (!element) return null;
      const info = await element.evaluate(node => ({tag: node.localName, id: node.id || null,
        title: node.getAttribute("title")}));
      const child = info.tag === "iframe" ? await element.contentFrame() : null;
      if (!child) return {tag: info.tag, id: info.id, ...(frames.length ? {frames} : {})};
      frames.push(info.title);
      frame = child;
    } finally {
      await handle.dispose();
    }
  }
}

function targetFor(page, step) {
  let scope = page;
  const owners = [];
  for (const title of step.frames ?? []) {
    const owner = scope.locator("iframe").and(scope.getByTitle(title, {exact: true}));
    owners.push({title, owner});
    scope = owner.contentFrame();
  }
  return {target: scope.getByRole(step.role, {name: step.name, exact: true}), owners};
}

export async function replay(page, steps, timeout = 2000) {
  const checks = [];
  for (const [index, step] of steps.entries()) {
    await page.keyboard.press(step.key);
    const {target, owners} = targetFor(page, step);
    const expected = {role: step.role, name: step.name};
    if (owners.length) expected.frames = step.frames;
    const check = {step: index + 1, key: step.key, expected};
    try {
      await expect(target).toBeFocused({ timeout });
    } catch (error) {
      if (page.isClosed()) throw error;
      for (const {title, owner} of owners) {
        const matches = await owner.count();
        if (matches === 1) continue;
        checks.push({...check, passed: false, reason: matches ? "ambiguous-frame" : "missing-frame",
          frame: title, matches, active: await activeNode(page)});
        return {passed: false, planned: steps.length, checks};
      }
      const matches = await target.count();
      const reason = matches === 0 ? "missing-target" : matches > 1 ? "ambiguous-target" : "wrong-focus";
      checks.push({ ...check, passed: false, reason, matches, active: await activeNode(page) });
      return { passed: false, planned: steps.length, checks };
    }
    checks.push({ ...check, passed: true, active: await activeNode(page) });
  }
  return { passed: true, planned: steps.length, checks };
}

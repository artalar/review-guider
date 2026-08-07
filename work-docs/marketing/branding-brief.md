# Branding and go-to-market brief

- **Product:** Guide Reviewer
- **Recommended launch name:** Tabthrough
- **Date:** 2026-08-07
- **Scope:** Positioning and launch guidance only. No package, command, or source identity changes are approved by this document.

## Executive decision

**Rename before the first public Marketplace release to _Tabthrough_, displayed as _Tabthrough — Guided Diff Review_.**

- **Why:** “Guide Reviewer” is understandable after explanation, but weak before it. It sounds like a tool that reviews guides, uses two crowded category words, and is easy to confuse with automated code reviewers. A close Marketplace result, [Smart Code Review Guide](https://marketplace.visualstudio.com/items?itemName=smart-code-review-guide.smart-code-review-guide), also markets AI-powered step-by-step review walkthroughs.
- **Why now:** the manifest is still `0.0.0`, and the configured Marketplace item URL returned 404 in the 2026-08-07 scan. There is no visible Marketplace equity to protect at that URL. Renaming becomes materially harder after `publisher.name` establishes an installed extension identity.
- **Why Tabthrough:** it makes the signature interaction memorable without claiming AI, PR hosting, or automated judgment. The initial collision scan found the phrase only as a generic UI option, not a developer review product.
- **Primary tagline:** **Understand every change, one Tab at a time.**
- **Confidence:** **80% rename; 70% Tabthrough as the final name.** The latter is conditional on trademark, Marketplace, package, domain, and social-handle clearance.

If the Product Owner declines a rename, do **not** launch with the naked display name. Use **Guide Reviewer — Guided Diff Review** consistently.

## 1. Name audit

### Is “Guide Reviewer” okay?

It is an adequate internal name and a mediocre launch brand.

| Dimension | Assessment |
|---|---|
| Immediate meaning | Weak. Grammatically, a “guide reviewer” reviews guides; the product guides a reviewer. |
| Product fit | Fair. It contains both core concepts and aligns with `.guide.json`. |
| Searchability | Weak. “Guide,” “review,” “reviewer,” and “code review” are crowded, generic terms. Exact-name search did not surface the configured listing. |
| Marketplace scan | Risky. “Smart Code Review Guide” occupies very similar language and a close step-by-step walkthrough promise. |
| Distinctiveness | Low. The name is descriptive, hard to defend, and hard to remember from a launch post. |
| Trademark posture | Low obvious aggression, but also low protectability. This is a directional brand assessment, not legal clearance. |
| Category confusion | High. Most “code reviewer” tools find defects, score risk, or post comments. This product changes how a human reads. |
| “Guide” overload | High. Product name, guided review, guide engine, `.guide.json`, authoring guide, and agent guide all compete in one sentence. |
| Existing implementation fit | High. Package, commands, settings, docs, schema URL, and agent skill already use it, so a rename must be coordinated. |

### Ranked alternatives

The scan is a knockout search, not trademark clearance.

| Rank | Name | One-line rationale | Principal risk |
|---:|---|---|---|
| **1** | **Tabthrough** | Distinctive, verbal, and built around the product’s signature “press Tab to unfold the change” interaction. | Tab can be disabled; “tab through” has generic UI usage and may over-bind the brand to one key. |
| **2** | **PatchPath** | Alliterative and clearly promises a route through a patch. | “Patch” can mean security fixes or modular-synth routing; a small unrelated PatchPath AI project exists. |
| **3** | **ReviewPath** | Names the core benefit—an intentional reading path—without implying automated findings. | Generic, weakly protectable, and could sound like a process consultancy. |
| **4** | **DiffTrail** | Short, visual, and compatible with a progressive reveal metaphor. | “Trail” can imply audit history; an unrelated screenshot/PDF utility already uses the name. |
| **5** | **ChangeWalk** | Human and approachable; naturally supports “walk the change” verbing. | Broad organizational-change associations make search intent poor. |
| **6** | **StepDiff** | Compact expression of stepwise diff reading. | A Meta research project already uses StepDiff; the word order is mechanical rather than memorable. |
| **7** | **Diffwalk** | Almost perfectly describes the experience. | **Reject:** an active, closely related CLI already uses it for narratively ordered code changes. |

Also reject **Hunkwise**, **PatchWise**, **Diffwise**, and **OwnDiff/Own the Diff**: all have active developer-review products or projects. “Code Tour” should remain a metaphor, not the name; it creates confusion with tools for touring a codebase rather than a change.

### Recommendation

Rename the public brand to **Tabthrough** before publication. Keep `.guide.json` as the format name: it is generic, already frozen as a contract, and should not churn with the product brand.

## 2. Positioning

### Category

**A guided diff reader for VS Code that reveals a code change one step at a time, in the order a human needs to understand it.**

### Differentiation

**GitHub, Reviewable, and Graphite organize review work; Copilot and Cursor help produce or assess code; diff summaries compress it. Tabthrough gives the human an ordered, source-level reading path and control of the pace.**

### Competitive frame

| Alternative | Its primary job | Tabthrough’s distinct job |
|---|---|---|
| GitHub pull-request review | Host discussion, comments, checks, and approval | Build a mental model locally from working changes, commits, or ranges |
| GitHub Copilot | Generate code and provide AI assistance, including review features | Keep the human reading the actual change; no model or account required |
| Cursor Tab | Predict and accelerate the next edit | Reuse a familiar motion to reveal the next piece worth understanding |
| Reviewable | Structure collaborative PR discussion and review state | Structure the order in which one reviewer encounters the code |
| Graphite | Create, stack, submit, and move PRs through a team workflow | Slow the local reading surface down to one coherent thought at a time |
| AI diff summaries | Replace detail with a compressed explanation | Sequence the detail so the reader forms their own explanation |

Do not position this as “another code reviewer.” It does not currently find bugs, publish comments, approve PRs, or generate an LLM review. Its wedge is **human comprehension of the source change itself**.

## 3. Slogans and hooks

### Short taglines — eight words or fewer

| Priority | Copy |
|---|---|
| ⭐ **Primary** | **Understand every change, one Tab at a time.** |
| **Runner-up** | **Every diff, in the order it makes sense.** |
| **Runner-up** | **Stop skimming. Follow the change.** |
| Option | A better path through every diff. |
| Option | Read the code. Keep the context. |
| Option | From file list to mental model. |
| Option | Review at the speed of understanding. |
| Option | The human way through a diff. |

### Marketplace one-liners — 120 characters or fewer

| Priority | Copy |
|---|---|
| ⭐ **Primary** | **Turn local changes and commits into a step-by-step diff walkthrough, ordered for understanding.** |
| **Runner-up** | **Read working-tree changes, commits, and ranges one step at a time—offline, in VS Code.** |
| **Runner-up** | **Press Tab to reveal a diff in a thoughtful order, with your workspace restored when you finish.** |

### Social hooks

| Priority | Copy |
|---|---|
| ⭐ **Primary** | **AI can write a thousand lines before lunch. You still need a mental model. Press Tab and read the change in the order it makes sense.** |
| **Runner-up** | **Git gives you a list of changed files. Tabthrough gives you a path through the change.** |
| **Runner-up** | **Cursor Tab helps code appear. Tabthrough uses Tab to help that code make sense.** |
| Option | **A summary tells you about the diff. A guided diff keeps you in the code.** |

Use the AI hook for Solo Shippers and social launch posts, not as the universal headline. The product works equally well for human-authored changes and does not yet generate LLM guides.

## 4. README and docs marketing guidance

### Lead with

1. **The emotion:** “I approved it, but I do not have a mental model of it.”
2. **The motion:** a short silent GIF—start a review, reveal a type, Tab to its consumer, show the ordering rationale, finish.
3. **The difference:** the code is revealed progressively in an intentional order, not summarized away.
4. **The action:** one command and one key.

The first screen should answer: what pain is this, what happens, and how do I try it?

### Proposed hero

> # Tabthrough
>
> **Understand every change, one Tab at a time.**
>
> Large diffs arrive as a list of files. Tabthrough turns your working changes, a commit, or a commit range into an ordered walkthrough: foundations before callers, schemas before migrations, implementation before proof. Press **Tab** to reveal one thought at a time in VS Code, at your pace. It works offline and restores your workspace when you are done.
>
> **Install from the VS Code Marketplace → run “Tabthrough: Review Working Changes” → press Tab.**

Until the rename and listing are live, treat the install link and proposed command title as copy direction, not current instructions.

### Recommended section order

1. Hero, 10–15 second demo, install CTA
2. **Why ordinary diffs are hard:** file order is not explanation order
3. **Try it in three steps:** select target → approve pre-flight → press Tab
4. **What the walkthrough feels like:** forward, back, rationale, finish
5. **What can be reviewed:** working tree, commit, commit range
6. **Trust and restoration:** concise safety promise plus link to the full design
7. **Bring the author’s intent:** `.guide.json` example and agent-authoring link
8. Configuration and command reference
9. Honest limitations and roadmap
10. Contributing, architecture, Reatom, license

### Demote

- **Stash and ref internals:** trust evidence, not the hero. Put them after the first successful-use path.
- **Reatom/reactive-vscode:** valuable contributor credibility, not a buyer benefit.
- **The full limitation matrix:** keep the important constraints visible, move protocol-level detail to docs.
- **LLM generation:** label it “planned.” Do not let a P1 item make the P0 product sound incomplete.

### Cut or tighten

- Replace **“Your work is never at risk”** with **“Designed to restore your workspace exactly.”** Absolute safety language makes one incident catastrophic for trust and overstates any test suite.
- Remove implementation phrases such as “pure function,” “own URI scheme,” “temp-index snapshot,” and “compare-and-swap” from the main flow. Keep them in an expandable trust section or architecture link.
- Keep one shortcut table, not separate prose and reference explanations of the same keys.
- Shorten Known Limitations to the few constraints that affect installation or first use; link the exhaustive matrix.
- Avoid “pedagogical” in customer-facing copy. “Ordered for understanding” says the same thing without sounding academic.

## 5. Marketplace listing

### Recommended listing

| Field | Recommendation |
|---|---|
| `displayName` | **Tabthrough — Guided Diff Review** |
| Fallback display name | **Guide Reviewer — Guided Diff Review** |
| Short description | **Turn local changes and commits into a step-by-step diff walkthrough, ordered for understanding.** |
| Primary category | **Visualization** |
| Secondary category | **Other** |
| Optional third category | **Education**, only if onboarding becomes a demonstrated use case |
| Drop | **SCM Providers**—the extension consumes Git; it does not provide an SCM |

### Keyword strategy

Use intent terms, not architecture terms:

`code review`, `diff viewer`, `git diff`, `guided review`, `change walkthrough`, `commit review`, `local changes`, `code understanding`, `onboarding`, `AI-generated code`

Do not use `AI code reviewer`, `pull request bot`, `PR comments`, or `LLM review` until those capabilities ship. “AI-generated code” is a valid use case; “AI-powered” is not yet a valid product claim.

### Icon and visual cues

- A folded or progressively revealed diff with one clear forward step.
- A subtle Tab-key shape or arrow; do not make a keyboard key the only recognizable object.
- One accent color against a dark neutral, readable at 128×128 and 32×32.
- Avoid robots, magic sparkles, checkmarks, shields, and magnifying glasses. They signal AI generation, automated approval, security, or defect finding.
- Avoid the VS Code logo as the main mark and check Microsoft brand rules before using editor chrome in promotional assets.

### Listing media

1. Animated hero: empty reveal → three coherent steps → completion.
2. Screenshot: native diff plus `4 of 17 · service.ts · types before callers`.
3. Screenshot: pre-flight summary, captioned **“Your current work comes back when the review ends.”**
4. Diagram: raw diff → offline order or `.guide.json` → human-paced reveal.

Every asset should show code, order, and pace. A static settings screenshot will not sell this product.

## 6. Audience messaging

### Careful Reviewer — primary

- **“Read foundations before callers, not files in alphabetical order.”**
- **“Finish with a mental model you can use in the review conversation.”**
- **“Move at your pace—no scores, quizzes, or forced checkpoints.”**

Avoid “prove you understood it.” That turns care into compliance and contradicts the product tone.

### Solo Shipper — AI-assisted

- **“Your agent finished the patch. Now build the mental model.”**
- **“Walk staged, unstaged, and untracked work without manual stash choreography.”**
- **“No API key, upload, or generated verdict—just you and the actual diff.”**

This is the strongest launch wedge for social channels because the pain is new, acute, and easy to demonstrate.

### Onboarder

- **“Turn a change into an asynchronous walkthrough, not a wall of files.”**
- **“Use `.guide.json` to preserve why one part should be read before another.”**
- **“Give a new teammate a path through the code without turning it into a test.”**

Do not claim guide export, live pairing, or a training dashboard; those are not current features.

## 7. Product language and naming consistency

### Identity migration, if approved

Make the rename one coordinated pre-publication change:

- Product and Marketplace display name: `Tabthrough`
- Proposed extension name: `tabthrough`
- Proposed repository: `tabthrough` rather than `review-guider`
- Command category and user-visible settings title: `Tabthrough`
- Proposed command/config namespace: `tabthrough.*`
- Homepage, issue URL, badges, screenshots, schema docs, agent skill, and social handles

GitHub repository redirects reduce link breakage, but update all first-party links anyway. The current combination—product `Guide Reviewer`, package `guide-reviewer`, repository `review-guider`—looks accidental and hurts recall.

Do not rename `.guide.json` or silently break the frozen v1 schema. If the `guide-reviewer.dev` schema URL changes, serve a permanent redirect. If any external users exist before the rename, preserve old command and configuration IDs as aliases rather than breaking their setup.

### Command Palette verbing

Prefer the target first and outcome second:

| Current direction | Recommended user-facing title |
|---|---|
| Start Review (Working Tree) | **Review Working Changes** |
| Start Review from Commit… | **Review a Commit…** |
| Start Review from Commit Range… | **Review a Commit Range…** |
| Next Step | **Reveal Next Change** |
| Previous Step | **Go Back One Change** |
| Finish Review | **Finish and Restore Workspace** |
| Cancel Review | **Cancel and Restore Workspace** |
| Forget Pending Restore | **Dismiss Pending Restore…** with explicit consequence text |

“Start Review from…” is implementation-shaped. “Review…” matches what the user came to do. Restoration belongs in Finish and Cancel because it resolves the only scary part of the workflow.

### Status bar voice

- Active: `$(book) 4 of 17 · service.ts · types before callers`
- Ready to advance: `Next: service.ts · first consumer of the new type`
- Complete: `Walkthrough complete · Finish and restore`
- Recovery: `Workspace restore needs attention`

Keep it calm, factual, and non-evaluative. No streaks, “great job,” percentages understood, risk grades, or reading-time pressure.

## 8. Proof and launch plan

### Social proof ladder

1. Dogfood on real, non-demo diffs with each primary persona.
2. Capture the before/after in the user’s words: “I would have opened X first; the guide started at Y, which made Z obvious.”
3. Ask one comprehension outcome after the session: **“Could you explain the shape of this change without reopening the diff?”**
4. Publish one representative change with its raw file order, guided order, and `.guide.json`.
5. Cite the safety approach and link to the round-trip/crash suites. Do not lead with a test count that will immediately go stale.
6. Add quotes only with permission, role, and concrete context. “Game changer” without evidence is worse than no quote.

Do not manufacture install badges, logos, testimonials, or “developers love it” copy before the evidence exists.

### Launch assets

- One 10–15 second silent GIF that works without narration.
- One longer screen recording with a real multi-file change.
- A sample repository containing a small change and optional `.guide.json`.
- A technical post: **“Git gives you file order. Code review needs explanation order.”**
- Marketplace page, GitHub README, and social profile using the same name, tagline, icon, and first screenshot.

### Channel plan

| Channel | Angle | CTA |
|---|---|---|
| VS Code Marketplace | Search intent: guided diff, commit review, local changes | Install and run **Review Working Changes** |
| GitHub | Open-source implementation, safety model, schema, contributor trust | Star, install, try on a real diff, open a focused issue |
| X / Twitter | GIF first; AI output volume versus human mental-model bandwidth | Quote-post with the first diff where ordering helped |
| Hacker News | **Show HN: A VS Code extension that reveals diffs in explanation order**; discuss heuristics, virtual docs, and restoration plainly | Try it; critique the ordering on a real repository |
| Reddit `r/programming` | Technical write-up, disclosed affiliation, no launch-copy dump; follow self-promotion rules | Discuss whether file order is the wrong review primitive |
| Reddit `r/vscode` | Concrete extension workflow and keybinding behavior | Install and report editor/keybinding friction |
| Discord | Share only in relevant VS Code, code-review, and agent-tool communities where project posts are allowed | Post the short demo and ask one specific workflow question |

Lead HN and Reddit with the design problem, not “we are excited to announce.” Answer criticism with implementation detail and limits. Do not spray the same copy into every community.

### Launch gates

- Name and identity decision complete; knockout and legal clearance recorded.
- Marketplace URL resolves and install instructions are tested from a clean VS Code profile.
- Manual safety, two-window, keybinding, and first-reveal drills are complete.
- README license/attribution and Marketplace metadata are internally consistent.
- Demo uses only shipped features.
- Native PR entry and LLM generation are visibly labeled planned, not implied.

## 9. Anti-patterns and competitive traps

| Trap | Why it fails | Better move |
|---|---|---|
| Exam language: prove, pass, test your understanding | Creates shame and rushing; several “ownership gate” tools already occupy this territory | “Build a mental model at your pace” |
| “AI will replace code review” | Contradicts the human-ownership thesis | “AI can write quickly; humans still need to understand” |
| “Review faster” as the headline | Competes on the incumbent axis and invites unsupported benchmarks | “Read in a better order” |
| “AI-powered” before P1 | Factually wrong for the current default product | “Offline heuristic, optional author guide” |
| Competing feature-for-feature with PR platforms | Highlights missing comments, approvals, CI, and native PR entry | Position as the local comprehension layer beside them |
| Competing with AI bug finders | Makes users expect findings and verdicts | State plainly: it guides the reader; it does not judge the code |
| Calling the heuristic semantic understanding | Overclaims path/tier/significance rules | “Thoughtful offline ordering heuristic” |
| Leading with stash internals | Makes the product feel dangerous before it feels useful | Demo value first, then prove restoration |
| Absolute safety claims | One edge case destroys credibility | Explain capture, restore, and recovery without “never” |
| “Code tour” as the category | Suggests whole-codebase onboarding and collides with established tour tools | “Guided diff reader” or “guided diff review” |
| Attacking Copilot/Cursor | Alienates the exact users with the strongest need | Present a complementary step after generation |

## 10. Open questions for the founder

1. Is the first wedge **careful teammate review** or **reviewing your own agent output**? The product supports both; launch copy should choose one.
2. Is “Tab” durable enough to carry the brand if accessibility needs or editor conventions make another key primary later?
3. Is the strongest promise **better reading order** or **human ownership**? Test both; do not combine them into a paragraph-long headline.
4. Should `.guide.json` become a product-independent open contract, with Tabthrough as one reader? That is strategically stronger but requires stewardship.
5. Launch before native PR entry, or wait? If launching now, every page must say working tree/commit/range rather than imply one-click GitHub PR review.
6. Which VS Code forks are explicitly supported and tested? Do not infer compatibility from the extension format.
7. What telemetry, if any, is acceptable for completion metrics while keeping the offline/privacy promise literal?
8. Is the Marketplace publisher identity `artalar` the long-term trust anchor, or should the product have an organization publisher before launch?
9. Who owns schema hosting and permanent redirects if the product domain changes?
10. What is the smallest credible proof point for launch: one caught issue, one improved explanation, or repeated session completion?

## Decision ask for the Product Owner

Approve one:

1. **Recommended — rename:** adopt **Tabthrough — Guided Diff Review**, reserve the identity, complete clearance, then update package/repository/source identity in one separate implementation change.
2. **Fallback — keep with subtitle:** ship as **Guide Reviewer — Guided Diff Review** and standardize the repository and public copy around that exact phrase.

Do not keep the current three-way identity (`Guide Reviewer` / `guide-reviewer` / `review-guider`) and do not publish first while postponing the decision. **Recommendation: option 1, with 80% confidence that a rename is the right launch decision.**

## Research note

Directional web and Marketplace collision scan completed 2026-08-07. Notable conflicts included [Smart Code Review Guide](https://marketplace.visualstudio.com/items?itemName=smart-code-review-guide.smart-code-review-guide), [Diffwalk](https://www.linkedin.com/posts/wrightryan_dialectical-review-reviewers-write-the-tests-activity-7454603401289588737-iU7r), [PatchWise](https://github.com/qualcomm/PatchWise), [Diffwise](https://diffwise.app/), [Hunkwise](https://github.com/molon/hunkwise), and [OwnDiff](https://github.com/owndiff/own-your-diff). Search results are evidence for product differentiation, not legal clearance.

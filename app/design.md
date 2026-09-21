# Design — Unnamed Space Idle Fleet Manager

A locked design system for the Fleet Manager app. Extend this file when the system grows; do not generate a different theme per screen.

## Genre

Modern-minimal technical workbench.

## Macrostructure family

- App pages: Workbench — left workspace rail, fixed context bar, asymmetric editor/inspector split.
- Content and empty states: Long Document — concise explanation and one next action.
- Marketing pages: not applicable.

## Theme

Dark, cool navy surfaces with a restrained electric-blue focus accent. Green, amber, and red are semantic only. Exact values live in `tokens.css`; application CSS must consume token names.

## Typography

- Display/body: Microsoft YaHei UI / PingFang SC, strong Chinese desktop readability.
- Data and IDs: Cascadia Code / JetBrains Mono.
- Headings are upright, compact, and functional.

## Spacing

4-point named scale from `tokens.css`. The workbench is compact but preserves 44 px controls and visible separation between task regions.

## Motion

- Control feedback: 120–220 ms transform/opacity only.
- Workspace and result state: one 220 ms fade/rise transition.
- Reduced motion: opacity-only, no spatial transition, at most 150 ms.

## Microinteractions stance

- Silent success when the changed state is visible; persistent inline notice when the action has no visible result.
- Focus is instant and always visible.
- Destructive configuration deletes retain explicit confirmation.

## CTA voice

- Primary: one blue-outline/fill action for the current task, using a specific verb.
- Success: green only for adopting Best Found.
- Secondary: neutral bordered controls; management actions live beside the object they affect.

## Per-page allowances

- App pages use no decorative enrichment; function is the visual content.
- Raw JSON is an advanced diagnostic surface and never the default editor.

## What screens must share

- Left navigation, context selector order, typography, semantic colors, 44 px controls, result vocabulary, and save-state treatment.

## What screens may differ

- Main region density: node editor, Galaxy rerun progress, and template/copy management can use different internal grids while retaining the same shell.

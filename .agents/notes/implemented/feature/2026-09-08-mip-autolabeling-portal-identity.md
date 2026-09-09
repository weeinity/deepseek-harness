# Agent Note: MIP Autolabeling portal identity

Status: implemented

English | [中文](2026-09-08-mip-autolabeling-portal-identity.zh.md)

## Problem

The MIP portal presents its deployment identity in independent browser and React locations. A MIP mark in the sidebar beside a whale favicon and blank-session Hero creates a mixed identity even though all three locations belong to the same application.

## Decision

`MipAutolabelingMark` in [`dsh-client-ui-primitives`](../../../../packages/client/ui-primitives/README.md) owns the React artwork. The sidebar fallback, blank-session Hero fallback, and both official-brand mark occupants render that shared component; the sidebar wordmark remains a separate occupant because the Hero needs only the mark.

[`apps/web/public/favicon.svg`](../../../../apps/web/public/favicon.svg) carries the same applied-label silhouette, transparent checkmark, and gold sparkle as a standalone SVG. Browser chrome and the [install manifest](../../../../apps/web/public/manifest.webmanifest) need that asset before the React plugin graph runs, so the favicon remains outside the slot system and its built-artifact test pins the matching identity.

The MIP palette is fixed artwork rather than theme ink. The Hero keeps its existing placement and reduced-motion-aware hover movement, while the document title, build badge, and install-manifest names remain independently configured text.

## Verification

The primitive test pins the mark's square sizing, view box, class forwarding, fixed fills, and transparent checkmark. Sidebar and Hero component tests assert the MIP fallback, the official-brand plugin test asserts one mark component in both slots, the keyless recorded lifecycle scenario checks the rendered identity, the browser startup test checks its hover movement, and the built-Web test pins the standalone favicon.

## Alternatives considered

**Keep the whale in the Hero and browser tab.** Rejected because one portal would continue to present two unrelated identities.

**Duplicate the React SVG in each feature package.** Rejected because the sidebar, Hero, and official build could drift; a Cordis-free primitive is the existing shared runtime owner for brand marks.

**Drive the favicon through a UI slot.** Rejected because the browser requests document metadata before the Client Loader and React slot tree are available, and the install manifest also needs a stable asset URL.

## Consequences

The portal presents the MIP mark consistently in browser chrome, the sidebar, and the blank-session Hero. An artwork change updates the shared React primitive and the standalone favicon together; tests make that asset-plane duplication explicit. Deployments that need another identity replace the slot occupants and must also supply matching browser metadata.

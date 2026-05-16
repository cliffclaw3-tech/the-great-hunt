# The Great Hunt Linear Prototype Plan

## Project

**The Great Hunt MVP — Weekend Warrior Treasure Finder**

Build a mobile-first field companion for weekend hunters who move between estate sales, auctions, antique shops, marketplace finds, and retail closeout aisles looking for underpriced items. The product surfaces comp data, sell-through signals, friction checks, and authenticity/condition protocols without telling the user what to buy.

## Milestones

1. **Field Prototype**
   - Turn the static prototype into a click-through MVP with realistic hunt workflows.
   - Validate that the weekend warrior persona is obvious in the first 10 seconds.

2. **Treasure Check**
   - Build the on-demand lookup flow for items found in the wild.
   - Capture item, category, hunting ground, asking price, distance, and condition notes.

3. **Treasure Radar**
   - Model the monitored feed/digest experience across hunting grounds.
   - Let users filter by source, distance, profit threshold, and margin.

4. **Trust and Safety**
   - Add authentication protocols, condition rubrics, and liability-safe language.
   - Keep the app in a data-not-advice posture.

## Issues To Create

### 1. Define weekend warrior persona and first-run positioning

**Description**
Make the product immediately read as a tool for people who hunt estate sales, auctions, antique shops, marketplace listings, and retail closeout aisles. The first screen should answer: “Is this app for the treasure hunt I do on Saturdays?”

**Acceptance criteria**
- Hero copy uses the weekend warrior framing.
- Supported hunting grounds are visible above the fold.
- The app avoids sounding like a finance dashboard or generic marketplace scraper.

### 2. Build hunting ground filter model

**Description**
Add a source model that separates hunting grounds from item categories. Hunting grounds should include estate sales, auctions, antique shops, marketplace finds, and closeout aisles.

**Acceptance criteria**
- Feed cards include both item category and hunting ground.
- Users can filter the feed by hunting ground.
- Categories remain flexible enough for watches, books, pens, vintage audio, knives, instruments, and retail arbitrage.

### 3. Prototype treasure radar feed

**Description**
Create the daily hunt list experience that helps a user decide where to spend limited weekend time.

**Acceptance criteria**
- Cards show ask price, fast-sale estimate, projected spread, comp count, absorption signal, distance, and confidence.
- Cards include practical pre-trip checks.
- Filter sliders update the qualified count and muted states.

### 4. Prototype on-demand treasure check

**Description**
Build the field lookup flow for a user standing in front of an item at an estate sale, antique shop, auction preview, marketplace pickup, or closeout aisle.

**Acceptance criteria**
- Form captures item, category, hunting ground, ask price, and distance.
- Result card is generated without making a buy/no-buy recommendation.
- Checklist reminds user to verify exact model/SKU/reference, condition, fees, repair costs, and haul-away friction.

### 5. Add category protocol library

**Description**
Create checklist-driven authentication and condition guidance for key categories.

**Acceptance criteria**
- Protocols exist for watches, books, pens, retail closeouts, and weekend route planning.
- Language never grades an item from photos.
- Guidance is framed as what the user must verify.

### 6. Define valuation data card rules

**Description**
Document the data contract for the transparent valuation card.

**Acceptance criteria**
- Fields include ask, fast-sale estimate, comp range, comp count, absorption, projected spread, distance, and confidence.
- Low comp count produces a low-confidence state.
- The card never says “buy,” “pass,” or “offer this.”

### 7. Add route planning concept

**Description**
Explore how the product helps the user plan a Saturday route across sources.

**Acceptance criteria**
- Route planning considers opening time, preview windows, distance, and source quality.
- The concept supports quick reorder by distance and expected opportunity.
- The design avoids exposing private hunting grounds by default.

### 8. Model marketplace lead workflow

**Description**
Define how marketplace finds differ from in-person estate/auction/antique-store finds.

**Acceptance criteria**
- Marketplace cards include pre-drive proof requests.
- User can track photos needed before meeting.
- Flow accounts for distance, pickup friction, and seller responsiveness.

### 9. Model retail closeout workflow

**Description**
Define the retail arbitrage flow for clearance aisles and closeout shelves.

**Acceptance criteria**
- Lookup supports exact SKU/UPC matching.
- Checklist includes box damage, return stickers, shipping, active/sold ratio, and platform fees.
- Copy makes clear that clearance price alone is not a signal.

### 10. Create liability-safe UI copy standard

**Description**
Create a copy standard for data-not-advice language across the app.

**Acceptance criteria**
- App avoids telling users what to buy, what to offer, or what an item is worth.
- App says estimates, comps, protocols, and user-set assumptions.
- Responsibility for verification remains with the user.

### 11. Prototype weekend warrior challenge

**Description**
Sketch the Phase 2 contest mechanic inspired by the $1k challenge.

**Acceptance criteria**
- Tracks stake, receipts, miles, sale proceeds, and verified profit.
- Defaults to private hunting grounds.
- Public sharing is opt-in and anonymized.

### 12. Convert prototype to mobile-first app shell

**Description**
Turn the current local HTML prototype into a more app-like shell optimized for phone use during a live hunt.

**Acceptance criteria**
- Primary actions are reachable on mobile.
- Text does not overflow in cards, controls, or buttons.
- Feed, lookup, protocols, and challenge views remain usable at narrow widths.

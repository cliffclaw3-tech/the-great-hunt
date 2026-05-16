# eBay Marketplace Insights Access Request

## App
The Great Hunt

## Requested API
Marketplace Insights API

## Requested scope
`https://api.ebay.com/oauth/api_scope/buy.marketplace.insights`

## Use case
The Great Hunt is a resale research app for weekend treasure hunters who evaluate estate sale, auction, antique shop, Facebook Marketplace, and retail closeout finds.

The app helps a user enter an item they found in the field, compare marketplace comps, review accepted and rejected comparable listings, and estimate a possible ask price and fast-sale price.

## Data use
The app uses eBay data for public marketplace research and comparable-price lookup only.

The app does not:
- Allow users to sign in with eBay
- Store eBay user tokens
- Store eBay member account data
- Manage listings, orders, messages, or seller activity
- Make purchases or financial transactions

## Why Marketplace Insights is needed
The app currently uses eBay Browse API active listings, which are useful for market context but are not enough for strong resale pricing decisions.

Marketplace Insights access would let the app compare against recent sold marketplace data, improving estimate quality, confidence scoring, and comp-review transparency.

## Example workflow
1. User enters: `Omega Seamaster 166.010`, category `Watches`, asking price `$860`.
2. The app searches eBay comparable sales.
3. The app filters low-quality matches such as parts, accessories, reproductions, bundles, and unrelated listings.
4. The user reviews accepted and rejected comps.
5. The app calculates low, median, high, suggested ask, fast-sale price, and confidence.

## Current implementation
The app is already using official eBay OAuth and Browse API credentials. Marketplace Insights support is implemented behind a disabled local feature flag:

```env
EBAY_ENABLE_MARKETPLACE_INSIGHTS=false
```

Once access is approved, the flag will be changed to:

```env
EBAY_ENABLE_MARKETPLACE_INSIGHTS=true
```

## Support timeline
- `260429-000009`: Initial API support ticket asking how to request Marketplace Insights access. eBay directed us to file an Application Growth Check.
- `260502-000014`: Application Growth Check filed for The Great Hunt.
- May 8, 2026: eBay asked for additional details about app/company, eBay UserID, EPN status, completed item usage, data storage/sharing, requested categories, and contact information. Response was submitted through the support site.
- May 10, 2026, 2:34 AM: eBay Developer Support replied that they are checking with the eBay business team on the status of the Application Growth Check request and will provide updates.

## Current status
Waiting on eBay business team review. This is not an approval yet, but it is also not a rejection. Keep `EBAY_ENABLE_MARKETPLACE_INSIGHTS=false` until eBay grants Marketplace Insights access.

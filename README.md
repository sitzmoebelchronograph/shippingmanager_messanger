# 🚢 Shipping Manager - CoPilot

A comprehensive "Addon" for the beloved game [Shipping Manager](https://shippingmanager.cc).

## Key Features at a Glance

* **Harbor Map**: Interactive world map with live fleet tracking, vessel/port details, route visualization, **weather overlays (rain, temperature, wind)**, and **maritime POI (museums, shipwrecks)**
* **Logbook**: Comprehensive event tracking for alliance activities, vessel operations, and game history
* **AutoPilot System**: Intelligent automation for fuel/CO2 purchasing, vessel operations, hijacking negotiation, and more
* **ChatBot**: Automated alliance assistant with **role-based commands**, scheduled announcements, and custom command support
* **Mobile Support**: As a Steam player, you can now receive **mobile notifications** via your Wi-Fi at home
* **Fleet Management**: Streamlined vessel purchasing, **bulk repairs**, automated departures, and **bulk selling with shopping cart**
* **Price Alerts**: Set up your own custom price alerts!
* **Alliance Cooperation**: Easily manage and send cooperation vessels to alliance members
* **Company Profile**: Track your achievements, progress, and company statistics
* **Bug-Free Chat**: Alliance chat and private messaging **without the page reload bugs** that Steam players commonly experience with [Shippingmanager.cc](https://shippingmanager.cc/)

...and much more!

Join the discord community [SM-Coplit](https://discord.gg/rw4yKxp7Mv)

---

## Table of Contents

- [🛠️ The Bug That Became The Tool](#️-the-bug-that-became-the-tool)
- [📢 A Message to Trophy Games](#-a-message-to-trophy-games)
- [🚀 Features](#-features)
  - [Alliance Chat](#alliance-chat)
  - [Private Messaging](#private-messaging)
  - [Fuel Management](#fuel-management)
  - [CO2 Management](#co2-management)
  - [Vessel Management](#vessel-management)
  - [Bulk Repair](#bulk-repair)
  - [Marketing Campaigns](#marketing-campaigns)
  - [Vessel Purchase Catalog](#vessel-purchase-catalog)
  - [Bulk Vessel Purchasing](#bulk-vessel-purchasing)
  - [Vessel Selling](#vessel-selling)
  - [Harbor Map](#harbor-map)
  - [Logbook](#logbook)
  - [Alliance Cooperation](#alliance-cooperation)
  - [Hijacking/Piracy Management](#hijackingpiracy-management)
  - [Forecast Calendar](#forecast-calendar)
  - [Company Profile](#company-profile)
  - [Header Data Display](#header-data-display)
  - [Notifications System](#notifications-system)
  - [Anchor Point Management](#anchor-point-management)
  - [ChatBot](#chatbot)
  - [Auto-Rebuy Fuel by Barrel Boss](#auto-rebuy-fuel-by-barrel-boss)
  - [Auto-Rebuy CO2 by Atmosphere Broker](#auto-rebuy-co2-by-atmosphere-broker)
  - [Auto-Depart All Vessels by Cargo Marshal](#auto-depart-all-vessels-by-cargo-marshal)
  - [Auto Bulk Repair by Yard Foreman](#auto-bulk-repair-by-yard-foreman)
  - [Auto Campaign Renewal by Reputation Chief](#auto-campaign-renewal-by-reputation-chief)
  - [Auto Coop Vessel Sending by Fair Hand](#auto-coop-vessel-sending-by-fair-hand)
  - [Auto Anchor Point Purchase by Harbormaster](#auto-anchor-point-purchase-by-harbormaster)
  - [Auto Negotiate Hijacking by Cap'n Blackbeard](#auto-negotiate-hijacking-by-capn-blackbeard)
  - [HTTPS Support & Certificate Management](#https-support--certificate-management)
- [Requirements](#requirements)
- [Documentation](#documentation)
- [Session Cookie Encryption](#session-cookie-encryption)
- [Route Optimization Detection & Tracking](#route-optimization-detection--tracking)
- [Legal Disclaimer & Risk Notice](#legal-disclaimer--risk-notice)
- [Security Notice](#security-notice)
- [Privacy & Data Collection](#privacy--data-collection)
- [License](#license)
- [Screenshots](#screenshots)

---

## 🛠️ The Bug That Became The Tool

This project started out of sheer **frustration with persistent bugs** in [Shipping Manager](https://shippingmanager.cc) and the complete lack of ongoing development by the creators.

Initially, I just wanted to build a **simple chat messenger** – something that would allow me to communicate with my alliance on Steam without constantly worrying about certain keystrokes triggering a full page reload (a well-known bug in the Steam Version that never gets fixed).

What truly annoyed me was the inability to log in through a standard browser using my Steam account to receive game notifications while moving around the house or to earn **Point Rewards from Ads on my mobile device**.

Given that I have paid money for in-game items, it felt a bit like **"I got scammed."** I decided: I want to create my own benefits, especially since I can't watch ads to earn points or even receive notifications while I'm at home...

Well... things got a little out of hand, and the result is what you see here now :-D

This **comprehensive standalone web interface** connects directly to the Shipping Manager API and is packed with features the normal game is missing.

---

### 📢 A Message to Trophy Games

> **@Dear Trophy Games**
>
> As a dedicated player and Steam user, I would highly appreciate seeing **premium features**, like the ones integrated here, fully and natively implemented into your system.
>
> Imagine 10,000 active players willing to pay 5 Euros monthly for such integrated features — that could generate an extra **50,000 Euros per month**. A business model that would be worthwhile for everyone!
>
> I warmly invite you to **cooperate**: If you appreciate some of my feature ideas and would like assistance integrating them into the official system, I am readily available.
>
> Furthermore, since *Shipping Manager* is a simulation, it would be wonderful if you would make your **API documentation** publicly accessible. This would allow the community to develop valuable UI extensions themselves without unnecessarily burdening your API with reverse engineering calls. Sorry about some potentially log spam in the past :P

---

## 🚀 Features

Here are the first available features. I'm sure I forgot a few, but you're welcome to explore!

### Alliance Chat
- **Price Alert**
- **Member Mentions**
- **Multi-line Support** (Use Shift+Enter for line breaks)

### Private Messaging
- **Private Conversations**: Send and receive private messages to/from other players
- **Message Inbox**: View all private conversations with unread count badge

### Fuel Management
- **Current Fuel capacity display**
- **One-click max fuel purchase** with detailed confirmation dialog
- **Price per ton display** (colorized like the game)

### CO2 Management
- **Current CO2 quota and capacity display**
- **One-click max CO2 purchase** with detailed confirmation dialog
- **Price per ton display** (colorized like the game)

### Vessel Management
- **Separate badge for vessels ready to depart & vessels at anchor**
- **Pending Vessels Badge**: Track vessels under construction with countdown timers
- **Pending Vessels Filter**: View all vessels being built with completion times
- **One-click "Depart All"** shows fuel/CO2 consumption and earnings per departure
  - **Important**: We check the demand per port before sending - vessels are only sent if demand exists at the destination port
  - **Configurable vessel utilization**: You can set how high the cargo load must be before a vessel will be sent

### Bulk Repair
- **Automatic detection** of vessels with high wear
- **Configurable wear threshold** (2%, 3%, 4%, 5%, 10%, 15%, 20%, 25%)
- **One-click bulk repair** with cost preview
- **Badge showing number** of vessels needing repair
- **Prevents repair** if insufficient funds

### Marketing Campaigns
- **View all available** marketing campaigns
- **Badges for campaign status** (active/inactive)
- **One-click campaign activation**
- **Badge shows number** of available campaigns

### Vessel Purchase Catalog
- **Browse all available vessels** for purchase
- **Advanced Filter System** (currently being expanded):
  - **Vessel Type**: Container/Tanker checkboxes
  - **Price Range**: Min/Max price filter
  - **Year Range**: Min/Max build year filter
  - **Engine Types**: Multi-select engine type filter
  - **Speed Range**: Min/Max speed filter (knots)
  - **Service Interval**: Min/Max service interval filter
  - **Fuel Factor**: Min/Max fuel efficiency filter
  - **CO2 Factor**: Min/Max CO2 efficiency filter
  - **Capacity Range**: Min/Max capacity filter (TEU for containers, BBL for tankers)
  - **Special Filters**: Credits-only vessels, Vessels with perks
- **Sorted by price** (cheapest first)
- **Detailed vessel specifications**:
  - Type, Year, Capacity, Speed, Range
  - Engine type and power (e.g., "mih_x1 (60,000 kW)")
  - Length, Fuel capacity
  - Service interval, Current port
  - **Efficiency Color Coding**: CO2 and Fuel factors with visual indicators
    - Green: Factor < 1.0 (efficient, below standard consumption)
    - Gray: Factor = 1.0 (standard efficiency)
    - Orange: Factor > 1.0 (inefficient, above standard consumption)
  - Special features (Gearless, Antifouling)
  - Width (if applicable), Perks (if available)
- **Quantity selection** (1-99 vessels per purchase)
- **Individual vessel purchase** with confirmation
- **Select multiple vessels** for bulk purchase
- **Comprehensive purchase confirmation dialogs**

### Bulk Vessel Purchasing
- **Shopping cart system** with "Add to Cart" button for each vessel
- **Cart button** shows total vessel count in cart
- **Shopping cart dialog** shows:
  - All cart items with quantity controls (+/- buttons)
  - Remove button for each item
  - Total items and total cost
  - Available cash and affordability status
  - Checkout button to purchase all items
- **Automatic stop** on vessel limit or insufficient funds

### Vessel Selling

- **Sell individual vessels** from your fleet
- **Bulk vessel selling** with checkbox-based multi-selection
- **Shopping cart system** for vessel sales:
  - Summary-first layout (Total Items, Total Revenue)
  - Cart items show original price (gray) and sell price (green)
  - Quantity controls (+/- buttons) for each vessel type
  - Remove individual items from cart
- **Direct checkbox controls** for individual vessel selection
- **Detailed sale confirmation** showing original price and sell price
- **Filter by vessel type**: Container/Tanker
- **Mobile-optimized** action buttons with emoji icons (🏁 Depart, 💵 Sell)
- **API-powered pricing** - real sell prices from game API (no fantasy formulas)

### Harbor Map

Interactive world map visualization of your fleet, ports, and routes:

- **Live Fleet Tracking**:
  - Real-time vessel positions on interactive Leaflet.js map
  - Color-coded vessel markers (green: in port, blue: at sea, orange: anchored)
  - Vessel tooltips with name, type, and status
  - Click vessels to open detailed info panel
- **Port Visualization**:
  - All game ports displayed with markers
  - Port tooltips showing port name and code
  - Click ports to view demand information
  - Filter: Show all ports or only your active ports
- **Route Display**:
  - Active routes drawn as lines on map
  - Color-coded by vessel status
  - Hover routes to see vessel details
  - Route filter with LocalStorage persistence (remembers your last selection)
- **Points of Interest (POI)**:
  - **Maritime Museums**: Toggle display of maritime museums worldwide (🏛️ button)
  - **Historic Shipwrecks**: Toggle display of documented shipwreck locations (⚓ button)
  - Real-time POI data from OpenStreetMap via cached API
  - Detailed tooltips with names, coordinates, and additional information
  - POI visibility persists across sessions
  - Automatic cache refresh every 24 hours
- **Map Themes**:
  - Standard light theme (default map view)
  - Dark mode with optimized controls and tooltips
  - **Satellite imagery** with transparent controls and adapted UI
  - All themes with optimized control styling and readability
- **Weather Overlays**:
  - **Rain radar overlay**: Real-time precipitation visualization
  - **Temperature overlay**: Global temperature map with color-coded zones
  - **Wind overlay**: Wind speed and direction visualization
  - Toggle controls for each overlay layer
  - Data from OpenWeatherMap
- **Vessel Detail Panel** (draggable):
  - Complete vessel specifications (capacity, range, speed, fuel, CO2)
  - Current position and status
  - Loaded cargo details with color-coded capacity
  - Maintenance hours and service info
  - Direct actions: Depart vessel, Sell vessel, View history
  - Mobile-optimized with emoji action buttons
- **Port Detail Panel** (draggable):
  - Demand information for all cargo types
  - View all vessels on this route
  - Route profitability calculations
- **Route Calculation**:
  - Automatic profit calculation per route
  - Fuel and CO2 consumption estimates
  - Duration calculation
  - Demand-based route optimization
- **Map Controls**:
  - Horizontal zoom controls with individually rounded buttons
  - Weather radar toggle with visual strike-through indicator when disabled
  - Theme switching (Standard/Dark/Satellite)
  - POI layer toggles (Museums/Wrecks)
  - Mobile swipe support
  - Zoom level display (bottom-left corner)
- **Panel Management**:
  - Drag panels to reposition
  - Close panels independently
  - Automatic layout on small screens

### Logbook

Comprehensive event tracking and history management:

- **Alliance Events Tracking**:
  - Member join/leave events
  - Cooperation vessel sending/receiving
  - Alliance chat milestones
  - Fuel and CO2 cooperation activities
- **Vessel Events Tracking**:
  - Route completions with earnings
  - Vessel purchases and sales
  - Repairs and maintenance
  - Hijacking incidents
  - Vessel departures
- **Event History**:
  - Chronological event timeline
  - Detailed event information (timestamp, type, details)
  - Filter by event type
  - Search functionality
  - Export to CSV/JSON
- **Event Notifications**:
  - Real-time event notifications
  - Event badges in UI
  - Customizable notification settings
- **Statistics**:
  - Total events by type
  - Event trends over time
  - Most active vessels/routes

### Alliance Cooperation

- **Coop Management Interface**:
  - Color-coded status: Green when all sent (0 available), Red when vessels need sending
  - Button badge shows available count only when > 0
- **Member List**:
  - Shows only enabled alliance members
  - Sorted by total vessel count (highest first)
  - Displays user ID, total vessels, and fuel amount
- **Coop Actions**:
  - One-click "Send max" button per member
  - Fully functional coop vessel sending

### Hijacking/Piracy Management

- **Ransom Negotiation**:
  - View all active hijacking cases
  - **Ransom Reduction Exploit** - Captain Blackbeard will handle this for you :)

### Forecast Calendar

Plan your fuel and CO2 purchases strategically with detailed price forecasts:

- **Price Forecast Visualization**:
  - Calendar-based display of upcoming fuel and CO2 prices
  - 30-minute interval precision for optimal buying windows
  - Color-coded pricing: Green for low prices, Yellow for medium, Red for high
  - Multi-day forecast view to plan ahead
  - Automatic timezone conversion
  - **Interactive calendar navigation** (previous/next day - swipe like a book)
  - Detailed hourly breakdown with exact timestamps
  - Identify the cheapest times to buy fuel and CO2
  - Compare prices across different days

### Company Profile

View and track your company achievements and statistics:

- **Company Overview**:
  - Company name and basic information
  - Achievement progress tracking
  - Company statistics and milestones
- **Achievement Tracking**:
  - Visual achievement table with progress indicators
  - Achievement types (e.g., revenue, vessels, routes)
  - Progress bars showing completion status
  - Completion dates for unlocked achievements
  - Organized table layout with proper column alignment
- **Statistics Dashboard**:
  - Company performance metrics
  - Historical data and trends
  - Visual progress tracking

### Header Data Display

Real-time monitoring of critical game metrics in the UI header:

- **Balance Indicators**:
  - Cash balance (auto-updates every 30s)
  - Premium points balance (live updates)
  - CEO level badge with golden star
- **Stock Market** (only visible if IPO active):
  - Current stock value
  - Trend indicator: up (green) for rising, down (red) for falling
- **Fleet Capacity**:
  - Anchor slots display (e.g., "7/101")
  - Shows available vessel capacity = max anchor points - total vessels
  - Helps plan purchases without hitting limits
- **Vessel Status Badges**:
  - Vessels ready to depart (in port)
  - Vessels at anchor (badge indicator)
  - Pending vessels under construction (with countdown timers)
- **Resource Levels**:
  - Current fuel and capacity display
  - Current CO2 quota and capacity display
  - Color-coded pricing

### Notifications System

Comprehensive notification system for critical events and automation feedback with in-app and desktop notification:

- Price alerts when fuel/CO2 drops below configured thresholds
- AutoPilot action notifications (purchases, departures, repairs, campaigns)

### Anchor Point Management

- View current anchor points and maximum capacity
- Purchase anchor points to increase fleet size

### ChatBot

Automated assistant for alliance communication and scheduled announcements:

**Alliance Commands**:
- `!forecast` - Get tomorrow's fuel/CO2 price forecast
- `!forecast <day>` - Get forecast for specific day (1-31)
- `!forecast <day> <timezone>` - Get forecast with timezone conversion
- `!help` - Display available commands and usage
- `!welcome <userID>` - Send welcome message to new alliance members (Admin only: CEO/COO/Management/Interim CEO)
- Customizable command prefix (default: !)
- Configurable cooldown to prevent spam (default: 30 seconds)
- Commands work in alliance chat and/or private messages (configurable per command)
- **Smart Validation**: Bot only responds to exact command formats (ignores invalid arguments or random text)
- **Role-Based Access Control**: Admin commands restricted to CEO, COO, Management, and Interim CEO roles

**Scheduled Messages**:
- Daily forecast announcements at configured time (UTC)
- Automatic timezone detection (CEST/CET based on season)
- Sends forecast for the next day to alliance chat
- Fully configurable schedule via settings

**Private Message Auto-Reply**:
- Responds to commands sent via private messages
- Same commands as alliance chat (configurable per command)
- Separate enable/disable toggle for DM functionality

**Custom Commands**:
- Create your own bot commands with custom responses
- Define response destination (alliance chat, DM, or both)
- Admin-only commands for restricted access
- Unlimited custom commands supported

### Auto-Rebuy Fuel by Barrel Boss

- Monitors fuel prices continuously
- Automatically purchases fuel when price drops at/below configured threshold
- Configurable threshold
- Event-driven: Triggers immediately when price drops
- Continues buying until bunker is full or funds threshold depleted
- Pure price-based strategy (no time windows)

### Auto-Rebuy CO2 by Atmosphere Broker

- Monitors CO2 prices continuously
- Automatically purchases CO2 when price drops at/below configured threshold
- Configurable threshold
- Event-driven: Triggers immediately when price drops
- Continues buying until bunker is full or funds depleted
- Pure price-based strategy (no time windows)

### Auto-Depart All Vessels by Cargo Marshal

- Continuously monitors vessels in port
- Automatically departs all ready vessels when fuel is available
- **Important**: We check the demand per port before sending - vessels are only sent if demand exists at the destination port
- **Two Operation Modes**:
  - **Use Route Defaults Mode** (default): Respects per-route configured settings (speed, utilization)
  - **Custom Global Settings Mode**: Override with global settings (minVesselUtilization, autoVesselSpeed)
- **Configurable vessel utilization threshold**: Set minimum cargo load percentage required before departure (e.g., only depart if vessel is at least 70% full)
- **Configurable vessel speed**: Set vessel speed as percentage of max_speed for fuel optimization
- Detects failed departures (insufficient fuel/CO2)
- Shows green success notification for successful departures
- Shows red error notification for failed departures ("Auto-Depart\nNo fuel - no vessels sent")

### Auto Bulk Repair by Yard Foreman

- Monitors all vessels for wear/maintenance needs
- Automatically repairs all vessels with wear > configured threshold
- Only repairs when sufficient funds are available

### Auto Campaign Renewal by Reputation Chief

- Monitors active marketing campaigns
- Automatically renews expired campaigns (reputation, awareness, green) with the best available
- Prevents campaign downtime
- Only activates when funds are sufficient

### Auto Coop Vessel Sending by Fair Hand

- Automatically sends cooperation vessels to alliance members
- Monitors available coop capacity
- Distributes vessels according to configured settings

### Auto Anchor Point Purchase by Harbormaster

- Automatically purchases additional anchor points when needed
- Monitors current fleet capacity vs available slots
- Only purchases when sufficient funds are available

### Auto Negotiate Hijacking by Cap'n Blackbeard

- Automated ransom negotiation
- Automatically negotiates with pirates to reduce ransom demands
- Uses aggressive negotiation tactics to achieve significant price reductions you can't have normally ;-)
- **Counter-Offer Strategy**: Makes 25% offers (25% of pirate's current demand)
- **Max 2 Counter-Offers**: After 2 counter-offers, automatically accepts the next pirate price
- **No Price Threshold**: Always accepts after 2 negotiations regardless of final price
- Automatically verifies payment and releases vessel
- Real-time negotiation notifications show progress

### HTTPS Support & Certificate Management

- **Automated Certificate Management**:
  - Self-signed certificates with automatic generation via dedicated `certificate_manager.py` module
  - **Automatic certificate installation** to OS certificate store on first start (may require user confirmation)
  - **Smart certificate renewal**: Automatically regenerates certificates when network configuration changes
  - **Multi-host support**: Certificates include all network IP addresses (localhost + LAN IPs) in Subject Alternative Names
  - **Cross-platform compatibility**: Works on Windows, macOS, and Linux
- **Network Access**:
  - Accessible from all devices on local network (https://your-local-ip:12345)
  - **Mobile device setup**: CA certificate download available in settings for manual installation on phones/tablets
  - **QR Code**: Settings page provides QR code for easy mobile access
- **Certificate Details**:
  - Valid for 365 days from generation
  - Automatically includes all network interfaces (WiFi, Ethernet, VPN)
  - Can be replaced with your own certificates if needed
  - Stored in `certs/` directory (localhost.pem + localhost-key.pem)
- **Security Notes**:
  - Self-signed certificates will show browser warnings on first visit (this is normal)
  - Certificate trust is automatically established during installation
  - All communication encrypted with TLS 1.2+

***

## Requirements

### Windows End-Users (Using .exe Installer)
- Modern web browser (Chrome/Chromium recommended)
- Active Shipping Manager account on Steam (alliance membership optional)

That's it! The installer includes everything else you need.

### Developers & Linux/Mac Users (Running from Source)
- **Installation Guide**: See [docs/tutorials/installation-guide.md](docs/tutorials/installation-guide.md)
- **Build Guide**: See [docs/tutorials/build-guide.md](docs/tutorials/build-guide.md)

***

## Documentation

Comprehensive JSDoc documentation is available when the application is running:

- Click the docs button in the UI (next to settings)

The documentation includes build instructions, installation guides, and complete API reference for all modules.

***

## Session Cookie Encryption

**All session cookies are automatically encrypted using OS-native secure storage!**

### How It Works

Session cookies are stored in `userdata/settings/sessions.json` (or `AppData/Local/ShippingManagerCoPilot/userdata/settings/sessions.json` when installed) but **never in plaintext**. The file only contains encrypted references like `KEYRING:session_1234567`. The actual cookie values are securely stored in your operating system's credential manager.

### Cross-Platform Security Backends

The application automatically uses the most secure storage available for your platform:

#### **Windows**
- **Backend**: Windows DPAPI (Data Protection API) + Credential Manager
- **Security**: Encrypted with your Windows user account credentials
- **Access**: Only you on this specific machine can decrypt
- **Location**: Windows Credential Manager (`Control Panel > Credential Manager`)

#### **macOS**
- **Backend**: macOS Keychain
- **Security**: Encrypted with Keychain encryption
- **Access**: Only you on this specific machine can decrypt
- **Location**: Keychain Access app

#### **Linux**
- **Backend**: libsecret (GNOME Keyring / KWallet)
- **Security**: Encrypted with Secret Service API
- **Access**: Only you on this specific machine can decrypt
- **Requirements**: `libsecret-1-dev` package must be installed

#### **Fallback Encryption**
If OS keyring is unavailable:
- Uses AES-256-GCM encryption with machine-specific key
- Key derived from: hostname + username + platform
- Still significantly more secure than plaintext

### Benefits

- **No plaintext cookies**: Even if someone copies your `sessions.json`, they cannot use it
- **Machine-locked**: Cookies can only be decrypted on the same machine by the same user
- **Zero configuration**: Works automatically, no setup required
- **New sessions protected**: All newly saved sessions are encrypted immediately

***

## Route Optimization Detection & Tracking

**Sub-Optimal Route Detection**

The application analyzes harbor fees and earnings for each route to identify potentially sub-optimal routes. When a route's harbor fees significantly reduce profitability, this indicates the route might not be optimal for that vessel.

When a sub-optimal route is detected during AutoPilot vessel departure, the application:
- Shows a warning side notification with route details
- Logs the transaction to the logbook with "⚠️ WARNING" status
- Preserves departure details for route optimization analysis
- Helps you identify which routes need optimization
- Allows you to adjust routes for better profitability

***

## Legal Disclaimer & Risk Notice

**This tool is not affiliated with Shipping Manager or Steam.**

**WARNING: USE OF THIS TOOL IS AT YOUR OWN RISK!**

This tool implements automated procedures to extract session cookies from the local Steam client cache and interacts directly with the game's API (`shippingmanager.cc`).

1.  **Violation of ToS:** These techniques **most likely** violate the Terms of Service (ToS) of both **Steam** and **Shipping Manager**.
2.  **Potential Consequences:** Use of this tool may lead to the **temporary suspension** or **permanent ban** of your Steam or game account.
3.  **No Liability:** The developers of this tool **assume no liability** for any damages or consequences resulting from its use. **Every user is solely responsible for complying with the respective terms of service.**

***

## Security Notice

**Your Session Cookie is extracted automatically and dynamically as described below!**

***

## Privacy & Data Collection

**This application collects ZERO data from users.**

- **No telemetry**: The software does not send any usage data, statistics, or analytics to the developer
- **No tracking**: Your gameplay data, account information, and activity remain completely private
- **Local only**: All data is stored locally on your machine (settings.json, session cookies in memory)
- **No external servers**: The application only communicates with shippingmanager.cc API - never with developer servers
- **Open source**: You can verify the code yourself - there are no hidden data collection mechanisms

**The developer has zero interest in your data.** This tool was created to solve a game bug, not to collect user information.

***

## License

AGPL-3.0-only WITH Commons Clause License Condition v1.0

Copyright (c) 2024-2025 sitzmoebelchronograph

This software is free to use and modify, but **may not be sold commercially**. See [LICENSE](LICENSE) file for full terms.

***

## Screenshots

![Application Demo](screenshots/demo.gif)

### Startup & Overview

<img src="screenshots/1_smcopilot_startup.png" width="50%">
<img src="screenshots/1_smcopilot_startup1.png" width="50%">
<img src="screenshots/2_smcopilot_overview_noally.png" width="50%">

### Fuel & CO2 Management

<img src="screenshots/3_smcopilot_purchase_fuel.png" width="50%">
<img src="screenshots/4_smcopilot_purchase_co2.png" width="50%">

### Vessel Management

<img src="screenshots/5_smcopilot_buy_vessels_.png" width="50%">
<img src="screenshots/5_smcopilot_buy_vessels_filter1.png" width="50%">
<img src="screenshots/5_smcopilot_buy_vessels_filter2.png" width="50%">
<img src="screenshots/5_smcopilot_buy_vessels_cart.png" width="50%">

### Vessel Selling

<img src="screenshots/6_smcopilot_sell_vessels_1.png" width="50%">
<img src="screenshots/6_smcopilot_sell_vessels_2.png" width="50%">

### Bulk Operations

<img src="screenshots/7_smcopilot_bulk_repair.png" width="50%">
<img src="screenshots/8_smcopilot_marketing_ampaigns.png" width="50%">

### Forecast & Anchor Points

<img src="screenshots/9_smcopilot_forecast.png" width="50%">
<img src="screenshots/10_smcopilot_purchase_anchorpoints.png" width="50%">

### Settings

<img src="screenshots/11_1_smcopilot_settings_pricealert.png" width="50%">
<img src="screenshots/11_2_smcopilot_settings_general.png" width="50%">
<img src="screenshots/14_smcopilot_settings_certs.png" width="50%">

### ChatBot

<img src="screenshots/12_1_smcopilot_chatbot_general.png" width="50%">
<img src="screenshots/12_2_smcopilot_chatbot_forecast.png" width="50%">
<img src="screenshots/12_3_smcopilot_chatbot_help_command.png" width="50%">
<img src="screenshots/12_4_smcopilot_chatbot_custom_commands.png" width="50%">

### AutoPilot

<img src="screenshots/13_1_smcopilot_autopilot_settings.png" width="50%">
<img src="screenshots/13_2_smcopilot_autopilot_barrel_boss.png" width="50%">
<img src="screenshots/13_3_smcopilot_autopilot_atmosphere_broker.png" width="50%">
<img src="screenshots/13_4_smcopilot_autopilot_cargo_marshal.png" width="50%">
<img src="screenshots/13_5_smcopilot_autopilot_harbormaster.png" width="50%">
<img src="screenshots/13_6_smcopilot_autopilot_reputation_Chief.png" width="50%">
<img src="screenshots/13_7_smcopilot_autopilot_fairhand.png" width="50%">
<img src="screenshots/13_8_smcopilot_autopilot_captain_blackbeard.png" width="50%">
<img src="screenshots/13_9_smcopilot_autopilot_yardforeman.png" width="50%">

### Logbook

<img src="screenshots/15_1_smcopilot_logbook.png" width="50%">
<img src="screenshots/15_2_smcopilot_logbook_details1.png" width="50%">
<img src="screenshots/15_3_smcopilot_logbook_details2.png" width="50%">
<img src="screenshots/15_4_smcopilot_logbook_details3.png" width="50%">
<img src="screenshots/15_5_smcopilot_logbook_details4.png" width="50%">

### Harbor Map

<img src="screenshots/16_1_smcopilot_map_overview.png" width="50%">
<img src="screenshots/16_2_smcopliot_map_cluster1.png" width="50%">
<img src="screenshots/16_3_smcopilot_map_cluster2.png" width="50%">
<img src="screenshots/16_4_smcopilot_map_modes.png" width="50%">
<img src="screenshots/16_5_smcopilot_map_filters.png" width="50%">
<img src="screenshots/16_6_smcopilo_map_harbor_click.png" width="50%">
<img src="screenshots/16_7_smcopilot_map_harbor_click_details.png" width="50%">
<img src="screenshots/16_8_smcopilot_map_vessel_click.png" width="50%">
<img src="screenshots/16_9_smcopilot_map_vessel_click_details1.png" width="50%">
<img src="screenshots/16_10_smcopilot_map_vessel_click_details2.png" width="50%">
<img src="screenshots/16_11_smcopilot_map_vessel_click_details3.png" width="50%">
<img src="screenshots/16_12_smcopilot_map_vessel_click_details4.png" width="50%">
<img src="screenshots/16_13_smcopilot_map_vessel_click_details_vessel-history_export.png" width="50%">

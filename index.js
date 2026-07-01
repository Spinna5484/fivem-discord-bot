require('dotenv').config();

const {
    Client,
    GatewayIntentBits,
    REST,
    Routes,
    SlashCommandBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder,
    EmbedBuilder,
    MessageFlags,
    PermissionsBitField
} = require('discord.js');
const mysql = require('mysql2/promise');
const fetch = require('node-fetch');

const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers]
});

const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

const DAILY_COOLDOWN = 86400000;
const WORK_COOLDOWN = 3600000;

const COMMAND_CHANNELS = {
    auctions: process.env.CHANNEL_AUCTIONS,
    bid: process.env.CHANNEL_AUCTIONS,

    balance: process.env.CHANNEL_BALANCE,
    daily: process.env.CHANNEL_BALANCE,
    work: process.env.CHANNEL_BALANCE,

    shop: process.env.CHANNEL_PURCHASE,
    buyvehicle: process.env.CHANNEL_PURCHASE,
    roleshop: process.env.CHANNEL_PURCHASE,
    buyrole: process.env.CHANNEL_PURCHASE,

    impounds: process.env.CHANNEL_IMPOUNDED,
    payimpound: process.env.CHANNEL_IMPOUNDED,
    sendtoauction: process.env.CHANNEL_IMPOUNDED,

    mypurchases: process.env.CHANNEL_COLLECT,
    myvehicles: process.env.CHANNEL_COLLECT,
    economy: process.env.CHANNEL_PURCHASE,
    licences: process.env.CHANNEL_PURCHASE,
    buylicence: process.env.CHANNEL_PURCHASE,
    addvehicle: process.env.CHANNEL_PURCHASE,
    vehicleclasses: process.env.CHANNEL_PURCHASE
};

const STRAIGHT_TO_AUCTION_ROLE_IDS = (process.env.STRAIGHT_TO_AUCTION_ROLE_IDS || '')
    .split(',')
    .map(v => v.trim())
    .filter(Boolean);

function memberCanUseStraightToAuction(member) {
    if (!member || !member.roles || !member.roles.cache) return false;
    if (!STRAIGHT_TO_AUCTION_ROLE_IDS.length) return false;
    return member.roles.cache.some(role => STRAIGHT_TO_AUCTION_ROLE_IDS.includes(role.id));
}

function generateClaimCode(length = 6) {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < length; i++) {
        code += chars[Math.floor(Math.random() * chars.length)];
    }
    return code;
}

function generateAuctionClaimCode(length = 6) {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < length; i++) {
        code += chars[Math.floor(Math.random() * chars.length)];
    }
    return code;
}

function generatePlate(length = 8) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let plate = '';
    for (let i = 0; i < length; i++) {
        plate += chars[Math.floor(Math.random() * chars.length)];
    }
    return plate;
}

const VEHICLE_CATEGORIES = {
    car: { label: 'Cars', emoji: '🚗', category: 'car', vehicle_class: null, required_licence: null },
    bike: { label: 'Motorcycles', emoji: '🏍️', category: 'bike', vehicle_class: null, required_licence: null },
    van: { label: 'Vans', emoji: '🚐', category: 'van', vehicle_class: null, required_licence: null },
    light_truck: { label: 'Light Trucks', emoji: '🚚', category: 'truck', vehicle_class: 'light', required_licence: null },
    heavy_truck: { label: 'Heavy Trucks (CDL)', emoji: '🚛', category: 'truck', vehicle_class: 'heavy', required_licence: 'cdl' },
    taxi: { label: 'Taxi', emoji: '🚕', category: 'taxi', vehicle_class: null, required_licence: 'taxi' },
    bus: { label: 'Buses', emoji: '🚌', category: 'bus', vehicle_class: null, required_licence: 'bus' },
    utility: { label: 'Utility / Tow', emoji: '🚜', category: 'utility', vehicle_class: null, required_licence: null },
    emergency: { label: 'Emergency', emoji: '🚓', category: 'emergency', vehicle_class: null, required_licence: null },
    airport: { label: 'Airport', emoji: '✈️', category: 'airport', vehicle_class: null, required_licence: 'airport' }
};

const SHOP_PAGE_SIZE = 10;

function normaliseCategory(category) {
    const value = String(category || 'car').toLowerCase().trim();
    return VEHICLE_CATEGORIES[value] ? value : 'car';
}

function getCategoryData(category) {
    return VEHICLE_CATEGORIES[normaliseCategory(category)] || VEHICLE_CATEGORIES.car;
}

function buildCategorySelect() {
    return new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId('shop_category_select')
            .setPlaceholder('Choose a vehicle category')
            .addOptions(
                Object.entries(VEHICLE_CATEGORIES).map(([value, data]) => ({
                    label: data.label,
                    value,
                    emoji: data.emoji
                }))
            )
    );
}

async function ensureVehicleShopColumns() {
    try {
        await pool.query(`ALTER TABLE bot_vehicle_shop ADD COLUMN category VARCHAR(50) NOT NULL DEFAULT 'car'`).catch(() => {});
        await pool.query(`ALTER TABLE bot_vehicle_shop ADD COLUMN image_url TEXT NULL`).catch(() => {});
        await pool.query(`ALTER TABLE bot_vehicle_shop ADD COLUMN is_new TINYINT(1) NOT NULL DEFAULT 0`).catch(() => {});
        await pool.query(`ALTER TABLE bot_vehicle_shop ADD COLUMN is_popular TINYINT(1) NOT NULL DEFAULT 0`).catch(() => {});
        await pool.query(`ALTER TABLE bot_vehicle_shop ADD COLUMN vehicle_class VARCHAR(50) NULL`).catch(() => {});
    } catch (error) {
        console.error('Vehicle shop schema ensure error:', error);
    }
}


const LICENCE_SHOP = {
    cdl: { label: 'Commercial Driver License (CDL)', price: 10000, description: 'Required for heavy trucks and trailer vehicles.' },
    taxi: { label: 'Taxi Driver Permit', price: 2500, description: 'Required for taxi vehicles and taxi work.' },
    bus: { label: 'Passenger Endorsement', price: 5000, description: 'Required for bus and coach vehicles.' },
    tow: { label: 'Tow Operator Permit', price: 3500, description: 'Required for tow trucks and recovery vehicles.' },
    airport: { label: 'Airport Security Pass', price: 2000, description: 'Required for airport cargo vehicles.' },
    tanker: { label: 'Hazmat / Tanker Endorsement', price: 7500, description: 'Required for tanker/fuel delivery vehicles.' }
};

async function ensureLicenceColumns() {
    try {
        await pool.query(`ALTER TABLE bot_vehicle_shop ADD COLUMN required_licence VARCHAR(100) NULL`).catch(() => {});
        await pool.query(`ALTER TABLE bot_vehicle_shop ADD COLUMN vehicle_class VARCHAR(50) NULL`).catch(() => {});
        await pool.query(`
            CREATE TABLE IF NOT EXISTS bot_job_licences (
                id INT AUTO_INCREMENT PRIMARY KEY,
                discord_id VARCHAR(50) NOT NULL,
                licence VARCHAR(100) NOT NULL,
                active TINYINT(1) NOT NULL DEFAULT 1,
                created_at BIGINT NULL,
                UNIQUE KEY uniq_discord_licence (discord_id, licence)
            )
        `).catch(() => {});
    } catch (error) {
        console.error('Licence schema ensure error:', error);
    }
}

async function hasLicence(discordId, licence) {
    if (!licence) return true;
    const [rows] = await pool.query(
        'SELECT id FROM bot_job_licences WHERE discord_id = ? AND licence = ? AND active = 1 LIMIT 1',
        [discordId, licence]
    );
    return rows.length > 0;
}

function buildLicencesEmbed(owned = []) {
    const ownedSet = new Set(owned.map(r => r.licence));
    const embed = new EmbedBuilder()
        .setTitle('Licences & Endorsements')
        .setDescription('Buy the correct licence before purchasing restricted vehicles.')
        .setColor(3447003)
        .setTimestamp(new Date());

    for (const [key, data] of Object.entries(LICENCE_SHOP)) {
        embed.addFields({
            name: `${ownedSet.has(key) ? 'Owned' : 'Not Owned'} - ${data.label}`,
            value: `Code: \`${key}\`\nPrice: **$${data.price}**\n${data.description}`,
            inline: true
        });
    }
    return embed;
}

function buildLicenceSelect() {
    return new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId('licence_select')
            .setPlaceholder('Choose a licence to buy')
            .addOptions(
                Object.entries(LICENCE_SHOP).map(([key, data]) => ({
                    label: data.label.slice(0, 100),
                    description: `$${data.price} - ${data.description}`.slice(0, 100),
                    value: key
                }))
            )
    );
}

async function buyLicenceForUser(interaction, licence) {
    const discordId = interaction.user.id;
    const data = LICENCE_SHOP[licence];

    if (!data) {
        return interaction.reply({ content: 'That licence does not exist.', flags: MessageFlags.Ephemeral });
    }

    const already = await hasLicence(discordId, licence);
    if (already) {
        return interaction.reply({ content: `You already have **${data.label}**.`, flags: MessageFlags.Ephemeral });
    }

    const user = await ensureUser(discordId);
    if (Number(user.balance) < Number(data.price)) {
        return interaction.reply({ content: `You need $${data.price} but only have $${user.balance}.`, flags: MessageFlags.Ephemeral });
    }

    await pool.query('UPDATE bot_users SET balance = balance - ? WHERE discord_id = ?', [data.price, discordId]);
    await pool.query(
        `INSERT INTO bot_job_licences (discord_id, licence, active, created_at)
         VALUES (?, ?, 1, ?)
         ON DUPLICATE KEY UPDATE active = 1, created_at = VALUES(created_at)`,
        [discordId, licence, Math.floor(Date.now() / 1000)]
    );

    return interaction.reply({ content: `Bought **${data.label}** for **$${data.price}**.`, flags: MessageFlags.Ephemeral });
}


async function getAvailableVehiclesForMember(member, section = null) {
    const [vehicles] = await pool.query('SELECT * FROM bot_vehicle_shop');
    const sectionData = section ? getCategoryData(section) : null;

    return vehicles
        .filter(v => !v.required_role_id || member.roles.cache.has(v.required_role_id))
        .filter(v => {
            if (!sectionData) return true;

            const vehicleCategory = String(v.category || 'car').toLowerCase().trim();
            const vehicleClass = v.vehicle_class ? String(v.vehicle_class).toLowerCase().trim() : null;

            if (vehicleCategory !== sectionData.category) return false;

            if (sectionData.vehicle_class) {
                return vehicleClass === sectionData.vehicle_class;
            }

            return true;
        })
        .sort((a, b) => Number(a.price || 0) - Number(b.price || 0));
}

function buildVehicleListEmbed(section, vehicles, page = 0) {
    const cat = getCategoryData(section);
    const totalPages = Math.max(1, Math.ceil(vehicles.length / SHOP_PAGE_SIZE));
    const safePage = Math.min(Math.max(page, 0), totalPages - 1);
    const pageItems = vehicles.slice(safePage * SHOP_PAGE_SIZE, (safePage + 1) * SHOP_PAGE_SIZE);

    const embed = new EmbedBuilder()
        .setTitle(`${cat.emoji} ${cat.label} Shop`)
        .setColor(3447003)
        .setDescription(
            vehicles.length
                ? `Select a vehicle from the menu below to buy it.\nPage **${safePage + 1}/${totalPages}**`
                : 'No vehicles are available in this section.'
        )
        .setTimestamp(new Date());

    for (const vehicle of pageItems) {
        const tags = [
            Number(vehicle.is_new) === 1 ? 'NEW' : null,
            Number(vehicle.is_popular) === 1 ? 'POPULAR' : null
        ].filter(Boolean);

        embed.addFields({
            name: `${vehicle.label || vehicle.vehicle_model}${tags.length ? ` • ${tags.join(' • ')}` : ''}`,
            value:
                `Model: \`${vehicle.vehicle_model}\`\n` +
                `Price: **$${vehicle.price}**\n` +
                `Class: **${vehicle.vehicle_class || 'None'}**\n` +
                `Licence: **${vehicle.required_licence || 'None'}**`,
            inline: true
        });
    }

    embed.setFooter({ text: `${vehicles.length} vehicle(s) in this section` });
    return embed;
}

function buildShopPageButtons(section, page, totalVehicles) {
    const totalPages = Math.max(1, Math.ceil(totalVehicles / SHOP_PAGE_SIZE));
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`shop_page:${normaliseCategory(section)}:${Math.max(page - 1, 0)}`)
            .setLabel('Previous')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(page <= 0),
        new ButtonBuilder()
            .setCustomId(`shop_page:${normaliseCategory(section)}:${Math.min(page + 1, totalPages - 1)}`)
            .setLabel('Next')
            .setStyle(ButtonStyle.Primary)
            .setDisabled(page >= totalPages - 1),
        new ButtonBuilder()
            .setCustomId('shop_back_categories')
            .setLabel('Back to Categories')
            .setStyle(ButtonStyle.Secondary)
    );
}

function buildVehicleSelect(section, vehicles, page = 0) {
    const pageItems = vehicles.slice(page * SHOP_PAGE_SIZE, (page + 1) * SHOP_PAGE_SIZE);

    return new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId(`shop_vehicle_select:${normaliseCategory(section)}:${page}`)
            .setPlaceholder('Choose a vehicle to purchase')
            .addOptions(
                pageItems.map(vehicle => ({
                    label: String(vehicle.label || vehicle.vehicle_model).slice(0, 100),
                    description: `$${vehicle.price} • ${vehicle.vehicle_model}`.slice(0, 100),
                    value: String(vehicle.vehicle_model).slice(0, 100)
                }))
            )
    );
}

function buildPurchaseConfirm(vehicle) {
    const embed = new EmbedBuilder()
        .setTitle(`Confirm Purchase • ${vehicle.label || vehicle.vehicle_model}`)
        .setColor(5763719)
        .addFields(
            { name: 'Model', value: `\`${vehicle.vehicle_model}\``, inline: true },
            { name: 'Price', value: `$${vehicle.price}`, inline: true },
            { name: 'Category', value: `${vehicle.category || 'car'}${vehicle.vehicle_class ? ' / ' + vehicle.vehicle_class : ''}`, inline: true },
            { name: 'Licence', value: vehicle.required_licence ? `Required: ${vehicle.required_licence}` : 'None', inline: true }
        )
        .setTimestamp(new Date());

    if (vehicle.image_url) {
        embed.setImage(vehicle.image_url);
    }

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`shop_buy_confirm:${vehicle.vehicle_model}`)
            .setLabel('Buy Vehicle')
            .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
            .setCustomId('shop_buy_cancel')
            .setLabel('Cancel')
            .setStyle(ButtonStyle.Secondary)
    );

    return { embed, row };
}


function buildEconomyHomeEmbed() {
    return new EmbedBuilder()
        .setTitle('Economy Management')
        .setDescription('Choose what you want to manage.')
        .setColor(3447003)
        .addFields(
            { name: 'Balance', value: 'Check your money.', inline: true },
            { name: 'Vehicle Shop', value: 'Buy cars, trucks, vans and more.', inline: true },
            { name: 'My Vehicles', value: 'View your owned vehicles.', inline: true },
            { name: 'Auctions', value: 'View active auctions.', inline: true },
            { name: 'Impounds', value: 'View your impounded vehicles.', inline: true }
        )
        .setTimestamp(new Date());
}

function buildEconomyHomeButtons() {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('economy_balance')
            .setLabel('Balance')
            .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
            .setCustomId('economy_shop')
            .setLabel('Vehicle Shop')
            .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
            .setCustomId('economy_myvehicles')
            .setLabel('My Vehicles')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('economy_auctions')
            .setLabel('Auctions')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('economy_impounds')
            .setLabel('Impounds')
            .setStyle(ButtonStyle.Secondary)
    );
}

async function buildMyVehiclesEmbed(discordId) {
    const [vehicles] = await pool.query(
        `SELECT vehicle_model, plate, garage, stored
         FROM bot_owned_vehicles
         WHERE discord_id = ?
         ORDER BY vehicle_model ASC`,
        [discordId]
    );

    const embed = new EmbedBuilder()
        .setTitle('My Vehicles')
        .setColor(5763719)
        .setTimestamp(new Date());

    if (!vehicles.length) {
        embed.setDescription('You do not own any claimed vehicles yet.');
        return embed;
    }

    for (const vehicle of vehicles.slice(0, 25)) {
        embed.addFields({
            name: `${vehicle.vehicle_model} [${vehicle.plate}]`,
            value: `Garage: **${vehicle.garage || 'out'}**\nStored: **${Number(vehicle.stored) === 1 ? 'Yes' : 'No'}**`,
            inline: true
        });
    }

    if (vehicles.length > 25) {
        embed.setFooter({ text: `Showing first 25 of ${vehicles.length} vehicles.` });
    }

    return embed;
}

async function buildAuctionsText() {
    const [rows] = await pool.query(
        `SELECT plate, vehicle_model, start_bid, highest_bid, ends_at, straight_to_auction
         FROM bot_auctions
         WHERE status = 'active'
         ORDER BY ends_at ASC
         LIMIT 20`
    );

    if (!rows.length) return 'There are no active auctions right now.';

    return rows.map(r =>
        `**${r.vehicle_model}** [${r.plate}] | ${Number(r.straight_to_auction) === 1 ? 'Straight' : 'Normal'} | Highest: **$${r.highest_bid}** | Ends: <t:${r.ends_at}:R>`
    ).join('\n');
}

async function buildImpoundsText(discordId) {
    const [rows] = await pool.query(
        `SELECT plate, vehicle_model, fee, reason, impound_method
         FROM bot_impounds
         WHERE owner_discord_id = ? AND status = 'impounded' AND direct_auction = 0
         ORDER BY impounded_at DESC
         LIMIT 20`,
        [discordId]
    );

    if (!rows.length) return 'You have no active impounds.';

    return rows.map(r =>
        `**${r.vehicle_model}** [${r.plate}] | Fee: **$${r.fee}** | Method: ${r.impound_method} | Reason: ${r.reason}`
    ).join('\n');
}

async function purchaseVehicleForUser(interaction, model) {
    const discordId = interaction.user.id;
    const member = await interaction.guild.members.fetch(discordId);

    const [vehicleRows] = await pool.query(
        'SELECT * FROM bot_vehicle_shop WHERE LOWER(vehicle_model) = LOWER(?) LIMIT 1',
        [model]
    );

    if (!vehicleRows.length) {
        return interaction.reply({ content: 'Vehicle not found in shop.', flags: MessageFlags.Ephemeral });
    }

    const vehicle = vehicleRows[0];

    if (vehicle.required_role_id && !member.roles.cache.has(vehicle.required_role_id)) {
        return interaction.reply({ content: 'You do not have the required role for that vehicle.', flags: MessageFlags.Ephemeral });
    }

    if (vehicle.required_licence) {
        const allowed = await hasLicence(discordId, vehicle.required_licence);
        if (!allowed) {
            const licenceData = LICENCE_SHOP[vehicle.required_licence];
            return interaction.reply({
                content: `You need **${licenceData ? licenceData.label : vehicle.required_licence}** to buy this vehicle. Use /licences first.`,
                flags: MessageFlags.Ephemeral
            });
        }
    }

    const [linkRows] = await pool.query('SELECT * FROM bot_links WHERE discord_id = ? LIMIT 1', [discordId]);

    if (!linkRows.length) {
        return interaction.reply({ content: 'Your Discord is not linked to FiveM yet. Use /linkdiscord in-game first.', flags: MessageFlags.Ephemeral });
    }

    const [balanceRows] = await pool.query('SELECT balance FROM bot_users WHERE discord_id = ? LIMIT 1', [discordId]);
    const currentBalance = balanceRows.length ? Number(balanceRows[0].balance) : 0;

    if (currentBalance < Number(vehicle.price)) {
        return interaction.reply({ content: `You need $${vehicle.price} but only have $${currentBalance}.`, flags: MessageFlags.Ephemeral });
    }

    const plate = generatePlate();
    const claimCode = generateClaimCode();

    await pool.query('UPDATE bot_users SET balance = balance - ? WHERE discord_id = ?', [vehicle.price, discordId]);

    await pool.query(
        `INSERT INTO bot_vehicle_purchases
         (discord_id, license, vehicle_model, plate, claimed, claim_code, claimed_at)
         VALUES (?, ?, ?, ?, 0, ?, NULL)`,
        [discordId, linkRows[0].license, vehicle.vehicle_model, plate, claimCode]
    );

    return interaction.reply({
        content:
            `Bought **${vehicle.label || vehicle.vehicle_model}** for **$${vehicle.price}**\n` +
            `Plate: **${plate}**\n` +
            `Claim Code: **${claimCode}**\n` +
            `Go to a dealership ped in-game and enter the code.`,
        flags: MessageFlags.Ephemeral
    });
}


async function ensureAuctionColumns() {
    try {
        await pool.query(`
            ALTER TABLE bot_auctions
            ADD COLUMN straight_to_auction TINYINT(1) NOT NULL DEFAULT 0
        `).catch(() => {});

        await pool.query(`
            ALTER TABLE bot_auctions
            ADD COLUMN created_by_discord_id VARCHAR(50) NULL DEFAULT NULL
        `).catch(() => {});

        await pool.query(`
            ALTER TABLE bot_impounds
            ADD COLUMN direct_auction TINYINT(1) NOT NULL DEFAULT 0
        `).catch(() => {});
    } catch (error) {
        console.error('Schema ensure error:', error);
    }
}

async function ensureUser(discordId) {
    const [rows] = await pool.query(
        'SELECT * FROM bot_users WHERE discord_id = ?',
        [discordId]
    );

    if (rows.length > 0) return rows[0];

    await pool.query(
        'INSERT INTO bot_users (discord_id, balance) VALUES (?, 0)',
        [discordId]
    );

    const [newRows] = await pool.query(
        'SELECT * FROM bot_users WHERE discord_id = ?',
        [discordId]
    );

    return newRows[0];
}

async function postToAuctionChannel(message) {
    try {
        const channelId = process.env.CHANNEL_AUCTIONS;
        if (!channelId) return;

        const channel = await client.channels.fetch(channelId).catch(() => null);
        if (!channel) return;

        await channel.send(message);
    } catch (error) {
        console.error('Auction channel post error:', error);
    }
}

async function sendAuctionWebhook(title, description, color = 3447003) {
    try {
        if (!process.env.AUCTION_WEBHOOK) return;

        await fetch(process.env.AUCTION_WEBHOOK, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                username: 'Auction System',
                embeds: [{
                    title,
                    description,
                    color,
                    timestamp: new Date().toISOString()
                }]
            })
        });
    } catch (error) {
        console.error('Auction webhook error:', error);
    }
}

async function syncGuildMemberRoles() {
    try {
        const guild = await client.guilds.fetch(process.env.GUILD_ID);
        const members = await guild.members.fetch();

        await pool.query('DELETE FROM bot_member_roles');

        for (const member of members.values()) {
            if (member.user.bot) continue;

            const discordId = member.user.id;

            for (const role of member.roles.cache.values()) {
                if (role.id === guild.id) continue;

                await pool.query(
                    'INSERT INTO bot_member_roles (discord_id, role_id, role_name) VALUES (?, ?, ?)',
                    [discordId, role.id, role.name]
                );
            }
        }

        console.log('Discord member roles synced');
    } catch (error) {
        console.error('Role sync error:', error);
    }
}

async function processRoleIncome() {
    try {
        const guild = await client.guilds.fetch(process.env.GUILD_ID);

        const [incomeRoles] = await pool.query(
            'SELECT * FROM bot_role_income WHERE enabled = 1'
        );

        if (!incomeRoles.length) return;

        const [users] = await pool.query(
            'SELECT discord_id FROM bot_users'
        );

        if (!users.length) return;

        for (const row of users) {
            try {
                const discordId = row.discord_id;
                const member = await guild.members.fetch(discordId).catch(() => null);

                if (!member || member.user.bot) continue;

                const matchingRoles = incomeRoles.filter(role =>
                    member.roles.cache.has(role.role_id)
                );

                if (!matchingRoles.length) continue;

                const highestRole = matchingRoles.reduce((highest, current) => {
                    if (!highest) return current;
                    return current.payout > highest.payout ? current : highest;
                }, null);

                const [claimRows] = await pool.query(
                    'SELECT * FROM bot_user_income_claims WHERE discord_id = ? AND role_id = ? LIMIT 1',
                    [discordId, highestRole.role_id]
                );

                const now = Date.now();
                const intervalMs = highestRole.interval_seconds * 1000;

                if (!claimRows.length) {
                    await pool.query(
                        'INSERT INTO bot_user_income_claims (discord_id, role_id, last_paid) VALUES (?, ?, ?)',
                        [discordId, highestRole.role_id, now]
                    );
                    continue;
                }

                const claim = claimRows[0];

                if (now - claim.last_paid >= intervalMs) {
                    await pool.query(
                        'UPDATE bot_users SET balance = balance + ? WHERE discord_id = ?',
                        [highestRole.payout, discordId]
                    );

                    await pool.query(
                        'UPDATE bot_user_income_claims SET last_paid = ? WHERE discord_id = ? AND role_id = ?',
                        [now, discordId, highestRole.role_id]
                    );

                    console.log(`Paid ${member.user.tag} $${highestRole.payout} for role ${highestRole.role_name}`);
                }
            } catch (memberError) {
                console.error(`Income error for user ${row.discord_id}:`, memberError);
            }
        }
    } catch (error) {
        console.error('Role income error:', error);
    }
}

function buildAuctionEmbed(auction, status = 'active') {
    const colorMap = {
        active: 3447003,
        sold: 5763719,
        expired: 9807270,
        failed: 15158332
    };

    return new EmbedBuilder()
        .setTitle(`Auction • ${auction.vehicle_model}`)
        .setColor(colorMap[status] || 3447003)
        .addFields(
            { name: 'Plate', value: auction.plate || 'Unknown', inline: true },
            { name: 'Type', value: Number(auction.straight_to_auction) === 1 ? 'Straight To Auction' : 'Normal Auction', inline: true },
            { name: 'Start Bid', value: `$${auction.start_bid ?? 0}`, inline: true },
            { name: 'Highest Bid', value: `$${auction.highest_bid ?? 0}`, inline: true },
            { name: 'Status', value: status.toUpperCase(), inline: true },
            {
                name: 'Ends',
                value: status === 'active'
                    ? `<t:${auction.ends_at}:F>\n(<t:${auction.ends_at}:R>)`
                    : 'Ended',
                inline: false
            }
        )
        .setTimestamp(new Date());
}

function buildAuctionButtons(auctionId, disabled = false) {
    return [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`auction_bid:${auctionId}:1000`)
                .setLabel('Bid +$1,000')
                .setStyle(ButtonStyle.Primary)
                .setDisabled(disabled),
            new ButtonBuilder()
                .setCustomId(`auction_bid:${auctionId}:5000`)
                .setLabel('Bid +$5,000')
                .setStyle(ButtonStyle.Success)
                .setDisabled(disabled),
            new ButtonBuilder()
                .setCustomId(`auction_bid:${auctionId}:10000`)
                .setLabel('Bid +$10,000')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(disabled)
        )
    ];
}

async function postAuctionEmbed(auction) {
    const channelId = process.env.CHANNEL_AUCTIONS;
    if (!channelId) return;

    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel) return;

    const message = await channel.send({
        embeds: [buildAuctionEmbed(auction, 'active')],
        components: buildAuctionButtons(auction.id, false)
    });

    await pool.query(
        `UPDATE bot_auctions
         SET announced = 1, message_id = ?, message_channel_id = ?
         WHERE id = ?`,
        [message.id, channel.id, auction.id]
    );
}

async function updateAuctionEmbed(auctionId, status = 'active') {
    const [rows] = await pool.query(
        `SELECT * FROM bot_auctions WHERE id = ? LIMIT 1`,
        [auctionId]
    );

    if (!rows.length) return;
    const auction = rows[0];

    if (!auction.message_id || !auction.message_channel_id) return;

    const channel = await client.channels.fetch(auction.message_channel_id).catch(() => null);
    if (!channel) return;

    const message = await channel.messages.fetch(auction.message_id).catch(() => null);
    if (!message) return;

    await message.edit({
        embeds: [buildAuctionEmbed(auction, status)],
        components: buildAuctionButtons(auction.id, status !== 'active')
    });
}

async function createAuctionFromImpound(impound, opts = {}) {
    const now = Math.floor(Date.now() / 1000);
    const auctionEnd = now + (24 * 60 * 60);
    const straightToAuction = opts.straightToAuction ? 1 : 0;
    const createdByDiscordId = opts.createdByDiscordId || null;

    const [existingAuction] = await pool.query(
        'SELECT id FROM bot_auctions WHERE impound_id = ? LIMIT 1',
        [impound.id]
    );

    if (existingAuction.length) {
        return { ok: false, message: 'That impound is already in auction.' };
    }

    await pool.query(
        `INSERT INTO bot_auctions
         (impound_id, plate, vehicle_model, owner_discord_id, owner_license, start_bid, highest_bid, started_at, ends_at, status, straight_to_auction, created_by_discord_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
        [
            impound.id,
            impound.plate,
            impound.vehicle_model,
            impound.owner_discord_id,
            impound.owner_license,
            impound.fee,
            impound.fee,
            now,
            auctionEnd,
            straightToAuction,
            createdByDiscordId
        ]
    );

    await pool.query(
        `UPDATE bot_impounds
         SET status = 'auction', direct_auction = ?
         WHERE id = ?`,
        [straightToAuction, impound.id]
    );

    await sendAuctionWebhook(
        straightToAuction ? 'Vehicle Sent Straight To Auction' : 'Vehicle Sent To Auction',
        `**Vehicle:** ${impound.vehicle_model}\n**Plate:** ${impound.plate}\n**Start Bid:** $${impound.fee}\n**Type:** ${straightToAuction ? 'Straight To Auction' : 'Normal Auction'}\n**Ends:** <t:${auctionEnd}:F>`,
        15105570
    );

    const [newAuction] = await pool.query(
        `SELECT * FROM bot_auctions WHERE impound_id = ? LIMIT 1`,
        [impound.id]
    );

    if (newAuction.length) {
        await postAuctionEmbed(newAuction[0]);
    }

    return {
        ok: true,
        auction: newAuction.length ? newAuction[0] : null,
        message: straightToAuction
            ? `**${impound.plate}** has been sent straight to auction.`
            : `**${impound.plate}** has been sent to auction.`
    };
}

async function placeAuctionBid(auction, discordId, amount) {
    if (auction.owner_discord_id === discordId && Number(auction.straight_to_auction) === 1) {
        return {
            ok: false,
            message: 'You cannot bid on your own vehicle when Straight to Auction is enabled.'
        };
    }

    if (auction.status !== 'active') {
        return { ok: false, message: 'That auction is no longer active.' };
    }

    if (amount <= auction.highest_bid) {
        return { ok: false, message: `Your bid must be higher than the current highest bid of $${auction.highest_bid}.` };
    }

    const [balanceRows] = await pool.query(
        'SELECT balance FROM bot_users WHERE discord_id = ? LIMIT 1',
        [discordId]
    );

    const currentBalance = balanceRows.length ? balanceRows[0].balance : 0;

    if (currentBalance < amount) {
        return { ok: false, message: `You need $${amount} but only have $${currentBalance}.` };
    }

    await pool.query(
        `UPDATE bot_auctions
         SET highest_bid = ?, highest_bidder_discord_id = ?
         WHERE id = ?`,
        [amount, discordId, auction.id]
    );

    await pool.query(
        `INSERT INTO bot_auction_bids
         (auction_id, bidder_discord_id, bid_amount, bid_at)
         VALUES (?, ?, ?, ?)`,
        [auction.id, discordId, amount, Math.floor(Date.now() / 1000)]
    );

    await sendAuctionWebhook(
        'New Auction Bid',
        `**Vehicle:** ${auction.vehicle_model}\n**Plate:** ${auction.plate}\n**Bidder:** <@${discordId}>\n**Bid:** $${amount}`,
        3066993
    );

    await postToAuctionChannel(
        `💸 **New Highest Bid**\n` +
        `Vehicle: **${auction.vehicle_model}**\n` +
        `Plate: **${auction.plate}**\n` +
        `Bidder: <@${discordId}>\n` +
        `Bid: **$${amount}**`
    );

    await updateAuctionEmbed(auction.id, 'active');

    return { ok: true, message: `Bid placed on **${auction.plate}** for **$${amount}**.` };
}

async function processImpoundsToAuctions() {
    try {
        const now = Math.floor(Date.now() / 1000);

        const [readyImpounds] = await pool.query(
            `SELECT * FROM bot_impounds
             WHERE status = 'impounded'
               AND (
                    direct_auction = 1
                    OR release_at <= ?
               )`,
            [now]
        );

        for (const impound of readyImpounds) {
            await createAuctionFromImpound(impound, {
                straightToAuction: Number(impound.direct_auction) === 1,
                createdByDiscordId: impound.impounded_by_discord_id || null
            });
        }
    } catch (error) {
        console.error('Impound to auction error:', error);
    }
}

async function settleAuctions() {
    try {
        const now = Math.floor(Date.now() / 1000);

        const [auctions] = await pool.query(
            `SELECT * FROM bot_auctions
             WHERE status = 'active' AND ends_at <= ?`,
            [now]
        );

        for (const auction of auctions) {
            if (!auction.highest_bidder_discord_id) {
                await pool.query(
                    `UPDATE bot_auctions SET status = 'expired' WHERE id = ?`,
                    [auction.id]
                );

                await sendAuctionWebhook(
                    'Auction Ended - No Bids',
                    `**Vehicle:** ${auction.vehicle_model}\n**Plate:** ${auction.plate}`,
                    9807270
                );

                await postToAuctionChannel(
                    `⚠️ **Auction Ended With No Bids**\n` +
                    `Vehicle: **${auction.vehicle_model}**\n` +
                    `Plate: **${auction.plate}**`
                );

                await updateAuctionEmbed(auction.id, 'expired');
                continue;
            }

            const [balanceRows] = await pool.query(
                'SELECT balance FROM bot_users WHERE discord_id = ? LIMIT 1',
                [auction.highest_bidder_discord_id]
            );

            const winnerBalance = balanceRows.length ? balanceRows[0].balance : 0;

            if (winnerBalance < auction.highest_bid) {
                await pool.query(
                    `UPDATE bot_auctions SET status = 'failed' WHERE id = ?`,
                    [auction.id]
                );

                await sendAuctionWebhook(
                    'Auction Failed - Winner Could Not Pay',
                    `**Vehicle:** ${auction.vehicle_model}\n**Plate:** ${auction.plate}\n**Winner:** <@${auction.highest_bidder_discord_id}>`,
                    15158332
                );

                await updateAuctionEmbed(auction.id, 'failed');
                continue;
            }

            const [linkRows] = await pool.query(
                'SELECT * FROM bot_links WHERE discord_id = ? LIMIT 1',
                [auction.highest_bidder_discord_id]
            );

            if (!linkRows.length) {
                await pool.query(
                    `UPDATE bot_auctions SET status = 'failed' WHERE id = ?`,
                    [auction.id]
                );

                await updateAuctionEmbed(auction.id, 'failed');
                continue;
            }

            const claimCode = generateAuctionClaimCode();

            await pool.query(
                'UPDATE bot_users SET balance = balance - ? WHERE discord_id = ?',
                [auction.highest_bid, auction.highest_bidder_discord_id]
            );

            await pool.query(
                `UPDATE bot_owned_vehicles
                 SET discord_id = ?, license = ?, stored = 1, garage = 'city_impound'
                 WHERE plate = ?`,
                [auction.highest_bidder_discord_id, linkRows[0].license, auction.plate]
            );

            await pool.query(
                `UPDATE bot_auctions
                 SET status = 'sold',
                     highest_bidder_license = ?,
                     claim_code = ?
                 WHERE id = ?`,
                [linkRows[0].license, claimCode, auction.id]
            );

            await sendAuctionWebhook(
                'Auction Sold',
                `**Vehicle:** ${auction.vehicle_model}\n**Plate:** ${auction.plate}\n**Winner:** <@${auction.highest_bidder_discord_id}>\n**Winning Bid:** $${auction.highest_bid}\n**Claim Code:** ${claimCode}`,
                5763719
            );

            await postToAuctionChannel(
                `✅ **Auction Sold**\n` +
                `Vehicle: **${auction.vehicle_model}**\n` +
                `Plate: **${auction.plate}**\n` +
                `Winner: <@${auction.highest_bidder_discord_id}>\n` +
                `Winning Bid: **$${auction.highest_bid}**`
            );

            await updateAuctionEmbed(auction.id, 'sold');
        }
    } catch (error) {
        console.error('Auction settle error:', error);
    }
}

async function announceNewAuctions() {
    try {
        const [rows] = await pool.query(
            `SELECT * FROM bot_auctions
             WHERE status = 'active' AND announced = 0 AND message_id IS NULL`
        );

        for (const auction of rows) {
            await postAuctionEmbed(auction);
        }
    } catch (error) {
        console.error('Auction announce error:', error);
    }
}

const commands = [
    new SlashCommandBuilder().setName('economy').setDescription('Open the economy management menu'),
    new SlashCommandBuilder().setName('licences').setDescription('View and buy licences'),
    new SlashCommandBuilder()
        .setName('buylicence')
        .setDescription('Buy a licence')
        .addStringOption(o => o.setName('licence').setDescription('Licence code').setRequired(true)),
    new SlashCommandBuilder().setName('balance').setDescription('Check your balance'),
    new SlashCommandBuilder().setName('daily').setDescription('Claim daily reward'),
    new SlashCommandBuilder().setName('work').setDescription('Work for money'),
    new SlashCommandBuilder().setName('roleshop').setDescription('View roles'),
    new SlashCommandBuilder()
        .setName('buyrole')
        .setDescription('Buy a role')
        .addStringOption(o => o.setName('name').setDescription('Role name').setRequired(true)),
    new SlashCommandBuilder().setName('vehicleclasses').setDescription('View vehicle shop sections and licence rules'),
    new SlashCommandBuilder()
        .setName('addvehicle')
        .setDescription('Admin: add or update a shop vehicle')
        .addStringOption(o => o.setName('model').setDescription('Vehicle spawn/model name').setRequired(true))
        .addStringOption(o => o.setName('label').setDescription('Display name').setRequired(true))
        .addIntegerOption(o => o.setName('price').setDescription('Vehicle price').setRequired(true))
        .addStringOption(o => o.setName('section').setDescription('Shop section').setRequired(true)
            .addChoices(
                { name: 'Cars', value: 'car' },
                { name: 'Motorcycles', value: 'bike' },
                { name: 'Vans', value: 'van' },
                { name: 'Light Trucks - No CDL', value: 'light_truck' },
                { name: 'Heavy Trucks - CDL', value: 'heavy_truck' },
                { name: 'Taxi - Accreditation', value: 'taxi' },
                { name: 'Buses - Bus Endorsement', value: 'bus' },
                { name: 'Utility / Tow', value: 'utility' },
                { name: 'Emergency', value: 'emergency' },
                { name: 'Airport', value: 'airport' }
            ))
        .addStringOption(o => o.setName('roleid').setDescription('Optional required Discord role ID').setRequired(false)),
    new SlashCommandBuilder().setName('shop').setDescription('View vehicles'),
    new SlashCommandBuilder()
        .setName('buyvehicle')
        .setDescription('Buy a vehicle')
        .addStringOption(o => o.setName('model').setDescription('Vehicle spawn/model name').setRequired(true)),
    new SlashCommandBuilder().setName('mypurchases').setDescription('View your unclaimed vehicle purchases'),
    new SlashCommandBuilder().setName('myvehicles').setDescription('View your claimed owned vehicles'),
    new SlashCommandBuilder().setName('impounds').setDescription('View your impounded vehicles'),
    new SlashCommandBuilder()
        .setName('payimpound')
        .setDescription('Pay an impound fee')
        .addStringOption(o => o.setName('plate').setDescription('Vehicle plate').setRequired(true)),
    new SlashCommandBuilder().setName('auctions').setDescription('View active auctions'),
    new SlashCommandBuilder()
        .setName('bid')
        .setDescription('Place a bid on an auction')
        .addStringOption(o => o.setName('plate').setDescription('Vehicle plate').setRequired(true))
        .addIntegerOption(o => o.setName('amount').setDescription('Bid amount').setRequired(true)),
    new SlashCommandBuilder()
        .setName('sendtoauction')
        .setDescription('Staff only: send an impounded vehicle straight to auction')
        .addStringOption(o => o.setName('plate').setDescription('Vehicle plate').setRequired(true))
].map(c => c.toJSON());

client.once('clientReady', async () => {
    console.log(`Logged in as ${client.user.tag}`);

    await ensureAuctionColumns();
    await ensureVehicleShopColumns();
    await ensureLicenceColumns();

    const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN);

    await rest.put(
        Routes.applicationCommands(process.env.CLIENT_ID),
        { body: [] }
    );

    await rest.put(
        Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
        { body: commands }
    );

    console.log('Commands refreshed');

    await syncGuildMemberRoles();
    await processRoleIncome();
    await processImpoundsToAuctions();
    await settleAuctions();
    await announceNewAuctions();

    setInterval(syncGuildMemberRoles, 300000);
    setInterval(processRoleIncome, 30000);
    setInterval(processImpoundsToAuctions, 60000);
    setInterval(settleAuctions, 60000);
    setInterval(announceNewAuctions, 15000);
});

client.on('interactionCreate', async interaction => {
    try {
        if (interaction.isStringSelectMenu()) {
            if (interaction.customId === 'licence_select') {
                return buyLicenceForUser(interaction, interaction.values[0]);
            }

            if (interaction.customId === 'shop_category_select') {
                const category = interaction.values[0];
                const member = await interaction.guild.members.fetch(interaction.user.id);
                const vehicles = await getAvailableVehiclesForMember(member, category);

                if (!vehicles.length) {
                    return interaction.update({
                        content: 'No vehicles are available in that category.',
                        embeds: [],
                        components: [buildCategorySelect()]
                    });
                }

                return interaction.update({
                    content: '',
                    embeds: [buildVehicleListEmbed(category, vehicles, 0)],
                    components: [buildVehicleSelect(category, vehicles, 0), buildShopPageButtons(category, 0, vehicles.length)]
                });
            }

            if (interaction.customId.startsWith('shop_vehicle_select:')) {
                const model = interaction.values[0];

                const [vehicleRows] = await pool.query(
                    'SELECT * FROM bot_vehicle_shop WHERE LOWER(vehicle_model) = LOWER(?) LIMIT 1',
                    [model]
                );

                if (!vehicleRows.length) {
                    return interaction.reply({ content: 'Vehicle not found.', flags: MessageFlags.Ephemeral });
                }

                const { embed, row } = buildPurchaseConfirm(vehicleRows[0]);

                return interaction.reply({
                    embeds: [embed],
                    components: [row],
                    flags: MessageFlags.Ephemeral
                });
            }
        }

        if (interaction.isButton()) {
            if (interaction.customId === 'economy_balance') {
                const [rows] = await pool.query('SELECT balance FROM bot_users WHERE discord_id = ? LIMIT 1', [interaction.user.id]);
                const balance = rows.length ? rows[0].balance : 0;
                return interaction.reply({ content: `Balance: $${balance}`, flags: MessageFlags.Ephemeral });
            }

            if (interaction.customId === 'economy_shop') {
                const embed = new EmbedBuilder()
                    .setTitle('Vehicle Shop')
                    .setDescription('Choose a section below.')
                    .setColor(3447003)
                    .setTimestamp(new Date());

                return interaction.reply({
                    embeds: [embed],
                    components: [buildCategorySelect()],
                    flags: MessageFlags.Ephemeral
                });
            }

            if (interaction.customId === 'economy_myvehicles') {
                return interaction.reply({
                    embeds: [await buildMyVehiclesEmbed(interaction.user.id)],
                    flags: MessageFlags.Ephemeral
                });
            }

            if (interaction.customId === 'economy_auctions') {
                return interaction.reply({
                    content: await buildAuctionsText(),
                    flags: MessageFlags.Ephemeral
                });
            }

            if (interaction.customId === 'economy_impounds') {
                return interaction.reply({
                    content: await buildImpoundsText(interaction.user.id),
                    flags: MessageFlags.Ephemeral
                });
            }

            if (interaction.customId.startsWith('shop_page:')) {
                const [, section, pageRaw] = interaction.customId.split(':');
                const page = Number(pageRaw) || 0;
                const member = await interaction.guild.members.fetch(interaction.user.id);
                const vehicles = await getAvailableVehiclesForMember(member, section);

                if (!vehicles.length) {
                    return interaction.update({
                        content: 'No vehicles are available in that section.',
                        embeds: [],
                        components: [buildCategorySelect()]
                    });
                }

                return interaction.update({
                    content: '',
                    embeds: [buildVehicleListEmbed(section, vehicles, page)],
                    components: [buildVehicleSelect(section, vehicles, page), buildShopPageButtons(section, page, vehicles.length)]
                });
            }

            if (interaction.customId === 'shop_back_categories') {
                const embed = new EmbedBuilder()
                    .setTitle('Vehicle Shop')
                    .setDescription('Choose a section below.')
                    .setColor(3447003)
                    .setTimestamp(new Date());

                return interaction.update({
                    content: '',
                    embeds: [embed],
                    components: [buildCategorySelect()]
                });
            }

            if (interaction.customId.startsWith('auction_bid:')) {
                const [prefix, auctionId, increment] = interaction.customId.split(':');

                const [rows] = await pool.query(
                    `SELECT * FROM bot_auctions WHERE id = ? LIMIT 1`,
                    [auctionId]
                );

                if (!rows.length) {
                    return interaction.reply({ content: 'Auction not found.', flags: MessageFlags.Ephemeral });
                }

                const auction = rows[0];
                const amount = Number(auction.highest_bid) + Number(increment);
                const result = await placeAuctionBid(auction, interaction.user.id, amount);

                return interaction.reply({ content: result.message, flags: MessageFlags.Ephemeral });
            }

            if (interaction.customId.startsWith('shop_buy_confirm:')) {
                const model = interaction.customId.split(':')[1];
                return purchaseVehicleForUser(interaction, model);
            }

            if (interaction.customId === 'shop_buy_cancel') {
                return interaction.reply({ content: 'Purchase cancelled.', flags: MessageFlags.Ephemeral });
            }

            return;
        }

        if (!interaction.isChatInputCommand()) return;

        const requiredChannel = COMMAND_CHANNELS[interaction.commandName];
        if (requiredChannel && interaction.channelId !== requiredChannel) {
            return interaction.reply({
                content: `You can only use \`/${interaction.commandName}\` in <#${requiredChannel}>.`,
                flags: MessageFlags.Ephemeral
            });
        }

        const discordId = interaction.user.id;
        const user = await ensureUser(discordId);

        if (interaction.commandName === 'economy') {
            return interaction.reply({
                embeds: [buildEconomyHomeEmbed()],
                components: [buildEconomyHomeButtons()],
                flags: MessageFlags.Ephemeral
            });
        }

        if (interaction.commandName === 'myvehicles') {
            return interaction.reply({
                embeds: [await buildMyVehiclesEmbed(discordId)],
                flags: MessageFlags.Ephemeral
            });
        }

        if (interaction.commandName === 'licences') {
            const [owned] = await pool.query(
                'SELECT licence FROM bot_job_licences WHERE discord_id = ? AND active = 1',
                [discordId]
            );

            return interaction.reply({
                embeds: [buildLicencesEmbed(owned)],
                components: [buildLicenceSelect()],
                flags: MessageFlags.Ephemeral
            });
        }

        if (interaction.commandName === 'buylicence') {
            const licence = interaction.options.getString('licence').toLowerCase();
            return buyLicenceForUser(interaction, licence);
        }

        if (interaction.commandName === 'balance') {
            const [rows] = await pool.query(
                'SELECT balance FROM bot_users WHERE discord_id = ? LIMIT 1',
                [discordId]
            );

            const freshBalance = rows.length ? rows[0].balance : 0;

            return interaction.reply({
                content: `💰 Balance: $${freshBalance}`,
                flags: MessageFlags.Ephemeral
            });
        }

        if (interaction.commandName === 'daily') {
            const now = Date.now();

            if (now - user.last_daily < DAILY_COOLDOWN) {
                return interaction.reply({
                    content: 'You already claimed daily.',
                    flags: MessageFlags.Ephemeral
                });
            }

            await pool.query(
                'UPDATE bot_users SET balance = balance + 5000, last_daily = ? WHERE discord_id = ?',
                [now, discordId]
            );

            return interaction.reply({
                content: 'You got $5000!',
                flags: MessageFlags.Ephemeral
            });
        }

        if (interaction.commandName === 'work') {
            const now = Date.now();

            if (now - user.last_work < WORK_COOLDOWN) {
                return interaction.reply({
                    content: 'You must wait before working again.',
                    flags: MessageFlags.Ephemeral
                });
            }

            const payout = Math.floor(Math.random() * 3000) + 1000;

            await pool.query(
                'UPDATE bot_users SET balance = balance + ?, last_work = ? WHERE discord_id = ?',
                [payout, now, discordId]
            );

            return interaction.reply({
                content: `You earned $${payout}`,
                flags: MessageFlags.Ephemeral
            });
        }

        if (interaction.commandName === 'roleshop') {
            const [roles] = await pool.query('SELECT * FROM bot_role_shop');
            const text = roles.map(r => `**${r.role_name}** - $${r.price}`).join('\n');

            return interaction.reply({
                content: text || 'No roles found.',
                flags: MessageFlags.Ephemeral
            });
        }

        if (interaction.commandName === 'buyrole') {
            const name = interaction.options.getString('name');

            const [rows] = await pool.query(
                'SELECT * FROM bot_role_shop WHERE LOWER(role_name) = LOWER(?)',
                [name]
            );

            if (!rows.length) {
                return interaction.reply({
                    content: 'Role not found',
                    flags: MessageFlags.Ephemeral
                });
            }

            const roleData = rows[0];

            if (user.balance < roleData.price) {
                return interaction.reply({
                    content: 'Not enough money',
                    flags: MessageFlags.Ephemeral
                });
            }

            const member = await interaction.guild.members.fetch(discordId);
            const role = interaction.guild.roles.cache.get(roleData.role_id);

            if (!role) {
                return interaction.reply({
                    content: 'That Discord role could not be found.',
                    flags: MessageFlags.Ephemeral
                });
            }

            await member.roles.add(role);

            await pool.query(
                'UPDATE bot_users SET balance = balance - ? WHERE discord_id = ?',
                [roleData.price, discordId]
            );

            return interaction.reply({
                content: `Bought ${roleData.role_name}`,
                flags: MessageFlags.Ephemeral
            });
        }

        if (interaction.commandName === 'auctions') {
            const [rows] = await pool.query(
                `SELECT plate, vehicle_model, start_bid, highest_bid, ends_at, straight_to_auction
                 FROM bot_auctions
                 WHERE status = 'active'
                 ORDER BY ends_at ASC`
            );

            if (!rows.length) {
                return interaction.reply({
                    content: 'There are no active auctions right now.',
                    flags: MessageFlags.Ephemeral
                });
            }

            const lines = rows.map(r =>
                `**${r.vehicle_model}** [${r.plate}] | Type: ${Number(r.straight_to_auction) === 1 ? 'Straight' : 'Normal'} | Start: $${r.start_bid} | Highest: $${r.highest_bid} | Ends: <t:${r.ends_at}:R>`
            );

            const chunks = [];
            let currentChunk = '';

            for (const line of lines) {
                if ((currentChunk + '\n' + line).length > 1800) {
                    chunks.push(currentChunk);
                    currentChunk = line;
                } else {
                    currentChunk = currentChunk ? `${currentChunk}\n${line}` : line;
                }
            }

            if (currentChunk) chunks.push(currentChunk);

            await interaction.reply({ content: chunks[0] });

            for (let i = 1; i < chunks.length; i++) {
                await interaction.followUp({ content: chunks[i] });
            }

            return;
        }

        if (interaction.commandName === 'bid') {
            const plate = interaction.options.getString('plate').trim();
            const amount = interaction.options.getInteger('amount');

            const [auctionRows] = await pool.query(
                `SELECT * FROM bot_auctions
                 WHERE plate = ? AND status = 'active'
                 LIMIT 1`,
                [plate]
            );

            if (!auctionRows.length) {
                return interaction.reply({
                    content: 'No active auction found for that plate.',
                    flags: MessageFlags.Ephemeral
                });
            }

            const result = await placeAuctionBid(auctionRows[0], discordId, amount);

            return interaction.reply({
                content: result.message,
                flags: MessageFlags.Ephemeral
            });
        }

        if (interaction.commandName === 'vehicleclasses') {
            const lines = Object.entries(VEHICLE_CATEGORIES).map(([key, data]) =>
                `**${data.label}** (\`${key}\`) | category: \`${data.category}\` | class: \`${data.vehicle_class || 'none'}\` | licence: \`${data.required_licence || 'none'}\``
            );

            return interaction.reply({
                content: lines.join('\n'),
                flags: MessageFlags.Ephemeral
            });
        }

        if (interaction.commandName === 'addvehicle') {
            const member = await interaction.guild.members.fetch(discordId);

            if (!member.permissions.has(PermissionsBitField.Flags.Administrator)) {
                return interaction.reply({
                    content: 'You need Administrator permission to use /addvehicle.',
                    flags: MessageFlags.Ephemeral
                });
            }

            const model = interaction.options.getString('model').toLowerCase().trim();
            const label = interaction.options.getString('label').trim();
            const price = interaction.options.getInteger('price');
            const section = interaction.options.getString('section');
            const roleId = interaction.options.getString('roleid');

            if (!model || !label || !price || price <= 0) {
                return interaction.reply({
                    content: 'Invalid vehicle details.',
                    flags: MessageFlags.Ephemeral
                });
            }

            const category = categoryForSection(section);
            const vehicleClass = classForSection(section);
            const requiredLicence = licenceForSection(section);

            await pool.query(
                `INSERT INTO bot_vehicle_shop
                 (vehicle_model, label, price, required_role_id, category, vehicle_class, required_licence)
                 VALUES (?, ?, ?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE
                    label = VALUES(label),
                    price = VALUES(price),
                    required_role_id = VALUES(required_role_id),
                    category = VALUES(category),
                    vehicle_class = VALUES(vehicle_class),
                    required_licence = VALUES(required_licence)`,
                [model, label, price, roleId || null, category, vehicleClass, requiredLicence]
            );

            return interaction.reply({
                content:
                    `Vehicle saved: **${label}** (\`${model}\`)\n` +
                    `Price: **$${price}**\n` +
                    `Section: **${getCategoryData(section).label}**\n` +
                    `Category: \`${category}\`\n` +
                    `Class: \`${vehicleClass || 'none'}\`\n` +
                    `Required Licence: \`${requiredLicence || 'none'}\``,
                flags: MessageFlags.Ephemeral
            });
        }

        if (interaction.commandName === 'shop') {
            const embed = new EmbedBuilder()
                .setTitle('Vehicle Shop')
                .setDescription('Choose a section below.')
                .setColor(3447003)
                .setTimestamp(new Date());

            return interaction.reply({
                embeds: [embed],
                components: [buildCategorySelect()],
                flags: MessageFlags.Ephemeral
            });
        }

        if (interaction.commandName === 'buyvehicle') {
            const model = interaction.options.getString('model').toLowerCase();
            return purchaseVehicleForUser(interaction, model);
        }

        if (interaction.commandName === 'mypurchases') {
            const [purchaseRows] = await pool.query(
                `SELECT vehicle_model, plate, claim_code
                 FROM bot_vehicle_purchases
                 WHERE discord_id = ? AND claimed = 0`,
                [discordId]
            );

            if (!purchaseRows.length) {
                return interaction.reply({
                    content: 'You have no unclaimed purchases.',
                    flags: MessageFlags.Ephemeral
                });
            }

            const lines = purchaseRows.map(r =>
                `**${r.vehicle_model}** | Plate: **${r.plate}** | Code: **${r.claim_code}**`
            );

            const chunks = [];
            let currentChunk = '';

            for (const line of lines) {
                if ((currentChunk + '\n' + line).length > 1800) {
                    chunks.push(currentChunk);
                    currentChunk = line;
                } else {
                    currentChunk = currentChunk ? `${currentChunk}\n${line}` : line;
                }
            }

            if (currentChunk) chunks.push(currentChunk);

            await interaction.reply({
                content: chunks[0],
                flags: MessageFlags.Ephemeral
            });

            for (let i = 1; i < chunks.length; i++) {
                await interaction.followUp({
                    content: chunks[i],
                    flags: MessageFlags.Ephemeral
                });
            }

            return;
        }

        if (interaction.commandName === 'impounds') {
            const [impoundList] = await pool.query(
                `SELECT plate, vehicle_model, fee, reason, impound_method, release_at
                 FROM bot_impounds
                 WHERE owner_discord_id = ? AND status = 'impounded' AND direct_auction = 0
                 ORDER BY impounded_at DESC`,
                [discordId]
            );

            if (!impoundList.length) {
                return interaction.reply({
                    content: 'You have no active impounds.',
                    flags: MessageFlags.Ephemeral
                });
            }

            const lines = impoundList.map(r =>
                `**${r.vehicle_model}** [${r.plate}] | Fee: $${r.fee} | Method: ${r.impound_method} | Reason: ${r.reason}`
            );

            const chunks = [];
            let currentChunk = '';

            for (const line of lines) {
                if ((currentChunk + '\n' + line).length > 1800) {
                    chunks.push(currentChunk);
                    currentChunk = line;
                } else {
                    currentChunk = currentChunk ? `${currentChunk}\n${line}` : line;
                }
            }

            if (currentChunk) chunks.push(currentChunk);

            await interaction.reply({
                content: chunks[0],
                flags: MessageFlags.Ephemeral
            });

            for (let i = 1; i < chunks.length; i++) {
                await interaction.followUp({
                    content: chunks[i],
                    flags: MessageFlags.Ephemeral
                });
            }

            return;
        }

        if (interaction.commandName === 'payimpound') {
            const plate = interaction.options.getString('plate').trim();

            const [impoundRows] = await pool.query(
                `SELECT * FROM bot_impounds
                 WHERE owner_discord_id = ? AND plate = ? AND status = 'impounded'
                 LIMIT 1`,
                [discordId, plate]
            );

            if (!impoundRows.length) {
                return interaction.reply({
                    content: 'No active impound found for that plate.',
                    flags: MessageFlags.Ephemeral
                });
            }

            const impound = impoundRows[0];

            const [balanceRows] = await pool.query(
                'SELECT balance FROM bot_users WHERE discord_id = ? LIMIT 1',
                [discordId]
            );

            const currentBalance = balanceRows.length ? balanceRows[0].balance : 0;

            if (currentBalance < impound.fee) {
                return interaction.reply({
                    content: `You need $${impound.fee} but only have $${currentBalance}.`,
                    flags: MessageFlags.Ephemeral
                });
            }

            await pool.query(
                'UPDATE bot_users SET balance = balance - ? WHERE discord_id = ?',
                [impound.fee, discordId]
            );

            await pool.query(
                `UPDATE bot_impounds
                 SET status = 'paid', paid_at = ?
                 WHERE id = ?`,
                [Date.now(), impound.id]
            );

            return interaction.reply({
                content: `Impound paid for **${impound.plate}**. You can now collect the vehicle from the impound lot.`,
                flags: MessageFlags.Ephemeral
            });
        }

        if (interaction.commandName === 'sendtoauction') {
            const member = await interaction.guild.members.fetch(discordId);

            if (!memberCanUseStraightToAuction(member)) {
                return interaction.reply({
                    content: 'You do not have permission to use Straight to Auction.',
                    flags: MessageFlags.Ephemeral
                });
            }

            const plate = interaction.options.getString('plate').trim();

            const [impoundRows] = await pool.query(
                `SELECT *
                 FROM bot_impounds
                 WHERE plate = ? AND status = 'impounded'
                 LIMIT 1`,
                [plate]
            );

            if (!impoundRows.length) {
                return interaction.reply({
                    content: 'No active impound found for that plate.',
                    flags: MessageFlags.Ephemeral
                });
            }

            const result = await createAuctionFromImpound(impoundRows[0], {
                straightToAuction: true,
                createdByDiscordId: discordId
            });

            return interaction.reply({
                content: result.message,
                flags: MessageFlags.Ephemeral
            });
        }
    } catch (error) {
        console.error(error);

        if (interaction.replied || interaction.deferred) {
            return interaction.followUp({
                content: 'Database connection failed or something else went wrong.',
                flags: MessageFlags.Ephemeral
            });
        }

        return interaction.reply({
            content: 'Database connection failed or something else went wrong.',
            flags: MessageFlags.Ephemeral
        });
    }
});

client.login(process.env.BOT_TOKEN);

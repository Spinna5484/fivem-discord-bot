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

    mypurchases: process.env.CHANNEL_COLLECT
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
    new SlashCommandBuilder().setName('balance').setDescription('Check your balance'),
    new SlashCommandBuilder().setName('daily').setDescription('Claim daily reward'),
    new SlashCommandBuilder().setName('work').setDescription('Work for money'),
    new SlashCommandBuilder().setName('roleshop').setDescription('View roles'),
    new SlashCommandBuilder()
        .setName('buyrole')
        .setDescription('Buy a role')
        .addStringOption(o => o.setName('name').setDescription('Role name').setRequired(true)),
    new SlashCommandBuilder().setName('shop').setDescription('View vehicles'),
    new SlashCommandBuilder()
        .setName('buyvehicle')
        .setDescription('Buy a vehicle')
        .addStringOption(o => o.setName('model').setDescription('Vehicle spawn/model name').setRequired(true)),
    new SlashCommandBuilder().setName('mypurchases').setDescription('View your unclaimed vehicle purchases'),
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
        if (interaction.isButton()) {
            const [prefix, auctionId, increment] = interaction.customId.split(':');

            if (prefix !== 'auction_bid') return;

            const [rows] = await pool.query(
                `SELECT * FROM bot_auctions WHERE id = ? LIMIT 1`,
                [auctionId]
            );

            if (!rows.length) {
                return interaction.reply({
                    content: 'Auction not found.',
                    flags: MessageFlags.Ephemeral
                });
            }

            const auction = rows[0];
            const amount = Number(auction.highest_bid) + Number(increment);
            const result = await placeAuctionBid(auction, interaction.user.id, amount);

            return interaction.reply({
                content: result.message,
                flags: MessageFlags.Ephemeral
            });
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

        if (interaction.commandName === 'shop') {
            const member = await interaction.guild.members.fetch(discordId);
            const [vehicles] = await pool.query('SELECT * FROM bot_vehicle_shop');

            const available = vehicles.filter(v =>
                !v.required_role_id || member.roles.cache.has(v.required_role_id)
            );

            if (!available.length) {
                return interaction.reply({
                    content: 'No vehicles available',
                    flags: MessageFlags.Ephemeral
                });
            }

            available.sort((a, b) => a.price - b.price);

            const pages = [];
            let current = '🚗 **Available Vehicles**\n\n';

            for (const v of available) {
                const line = `**${v.label}** (\`${v.vehicle_model}\`) - $${v.price}\n`;

                if ((current + line).length > 1800) {
                    pages.push(current);
                    current = '🚗 **Available Vehicles**\n\n' + line;
                } else {
                    current += line;
                }
            }

            if (current.trim()) {
                pages.push(current);
            }

            await interaction.reply({
                content: pages[0],
                flags: MessageFlags.Ephemeral
            });

            for (let i = 1; i < pages.length; i++) {
                await interaction.followUp({
                    content: pages[i],
                    flags: MessageFlags.Ephemeral
                });
            }

            return;
        }

        if (interaction.commandName === 'buyvehicle') {
            const model = interaction.options.getString('model').toLowerCase();
            const member = await interaction.guild.members.fetch(discordId);

            const [vehicleRows] = await pool.query(
                'SELECT * FROM bot_vehicle_shop WHERE LOWER(vehicle_model) = LOWER(?) LIMIT 1',
                [model]
            );

            if (!vehicleRows.length) {
                return interaction.reply({
                    content: 'Vehicle not found in shop.',
                    flags: MessageFlags.Ephemeral
                });
            }

            const vehicle = vehicleRows[0];

            if (vehicle.required_role_id && !member.roles.cache.has(vehicle.required_role_id)) {
                return interaction.reply({
                    content: 'You do not have the required role for that vehicle.',
                    flags: MessageFlags.Ephemeral
                });
            }

            const [linkRows] = await pool.query(
                'SELECT * FROM bot_links WHERE discord_id = ? LIMIT 1',
                [discordId]
            );

            if (!linkRows.length) {
                return interaction.reply({
                    content: 'Your Discord is not linked to FiveM yet. Use /linkdiscord in-game first.',
                    flags: MessageFlags.Ephemeral
                });
            }

            const [balanceRows] = await pool.query(
                'SELECT balance FROM bot_users WHERE discord_id = ? LIMIT 1',
                [discordId]
            );

            const currentBalance = balanceRows.length ? balanceRows[0].balance : 0;

            if (currentBalance < vehicle.price) {
                return interaction.reply({
                    content: `You need $${vehicle.price} but only have $${currentBalance}.`,
                    flags: MessageFlags.Ephemeral
                });
            }

            const plate = generatePlate();
            const claimCode = generateClaimCode();

            await pool.query(
                'UPDATE bot_users SET balance = balance - ? WHERE discord_id = ?',
                [vehicle.price, discordId]
            );

            await pool.query(
                `INSERT INTO bot_vehicle_purchases
                 (discord_id, license, vehicle_model, plate, claimed, claim_code, claimed_at)
                 VALUES (?, ?, ?, ?, 0, ?, NULL)`,
                [discordId, linkRows[0].license, vehicle.vehicle_model, plate, claimCode]
            );

            return interaction.reply({
                content:
                    `Bought **${vehicle.label}** for **$${vehicle.price}**\n` +
                    `Plate: **${plate}**\n` +
                    `Claim Code: **${claimCode}**\n` +
                    `Go to a dealership ped in-game and enter the code.`,
                flags: MessageFlags.Ephemeral
            });
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
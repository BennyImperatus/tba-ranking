require('dotenv').config();
const axios = require('axios');

const SHARED_SECRET = process.env.SHARED_SECRET;
const GROUP_ID = process.env.GROUP_ID;
const OPEN_CLOUD_API_KEY = process.env.OPEN_CLOUD_API_KEY;
const ROBLOX_COOKIE = process.env.ROBLOX_COOKIE;

let cachedRoles = null;
let cachedRolesAt = 0;

async function getGroupRoles() {
	const now = Date.now();
	if (cachedRoles && now - cachedRolesAt < 5 * 60 * 1000) return cachedRoles;

	const response = await axios.get(
		`https://apis.roblox.com/cloud/v2/groups/${GROUP_ID}/roles`,
		{ headers: { 'x-api-key': OPEN_CLOUD_API_KEY } }
	);
	cachedRoles = response.data.groupRoles || response.data.roles || [];
	cachedRolesAt = now;
	return cachedRoles;
}

async function getMembership(userId) {
	const response = await axios.get(
		`https://apis.roblox.com/cloud/v2/groups/${GROUP_ID}/memberships`,
		{
			headers: { 'x-api-key': OPEN_CLOUD_API_KEY },
			params: { filter: `user == 'users/${userId}'`, maxPageSize: 1 },
		}
	);
	const memberships = response.data.groupMemberships || [];
	return memberships[0] || null;
}

async function promoteWithOpenCloud(userId) {
	const membership = await getMembership(userId);
	if (!membership) throw new Error('Nutzer ist kein Gruppenmitglied');

	const roles = (await getGroupRoles()).slice().sort((a, b) => a.rank - b.rank);
	const currentRoleId = membership.role.split('/').pop();
	const currentIndex = roles.findIndex((r) => String(r.id) === String(currentRoleId));
	const nextRole = roles[currentIndex + 1];

	if (!nextRole || nextRole.rank >= 255) {
		throw new Error('Bereits höchster Rang oder keine höhere Rolle gefunden');
	}

	const membershipId = membership.path.split('/').pop();
	await axios.post(
		`https://apis.roblox.com/cloud/v2/groups/${GROUP_ID}/memberships/${membershipId}:assignRole`,
		{ role: `groups/${GROUP_ID}/roles/${nextRole.id}` },
		{ headers: { 'x-api-key': OPEN_CLOUD_API_KEY } }
	);

	return nextRole.id;
}

async function getCsrfToken() {
	try {
		await axios.post('https://auth.roblox.com/v2/logout', {}, {
			headers: { Cookie: `.ROBLOSECURITY=${ROBLOX_COOKIE}` },
		});
	} catch (err) {
		const token = err.response && err.response.headers['x-csrf-token'];
		if (token) return token;
	}
	throw new Error('CSRF-Token konnte nicht abgerufen werden');
}

async function promoteWithCookie(userId) {
	if (!ROBLOX_COOKIE) throw new Error('Kein Fallback-Cookie konfiguriert');

	const csrfToken = await getCsrfToken();

	const rolesResponse = await axios.get(`https://groups.roblox.com/v1/groups/${GROUP_ID}/roles`);
	const roles = rolesResponse.data.roles.sort((a, b) => a.rank - b.rank);

	const memberResponse = await axios.get(`https://groups.roblox.com/v2/groups/${GROUP_ID}/users/${userId}`);
	const currentIndex = roles.findIndex((r) => r.id === memberResponse.data.role.id);
	const nextRole = roles[currentIndex + 1];

	if (!nextRole || nextRole.rank >= 255) {
		throw new Error('Bereits höchster Rang oder keine höhere Rolle gefunden');
	}

	await axios.patch(
		`https://groups.roblox.com/v1/groups/${GROUP_ID}/users/${userId}`,
		{ roleId: nextRole.id },
		{ headers: { Cookie: `.ROBLOSECURITY=${ROBLOX_COOKIE}`, 'X-CSRF-TOKEN': csrfToken } }
	);

	return nextRole.id;
}

module.exports = async (req, res) => {
	if (req.method !== 'POST') {
		return res.status(405).json({ success: false, error: 'Methode nicht erlaubt' });
	}

	const { secret, userId } = req.body;

	if (secret !== SHARED_SECRET) {
		return res.status(401).json({ success: false, error: 'Ungültiges Secret' });
	}
	if (!userId) {
		return res.status(400).json({ success: false, error: 'userId fehlt' });
	}

	try {
		const newRoleId = await promoteWithOpenCloud(userId);
		return res.json({ success: true, method: 'opencloud', newRoleId });
	} catch (openCloudError) {
		console.warn(`Open Cloud fehlgeschlagen für ${userId}:`, openCloudError.message);
		try {
			const newRoleId = await promoteWithCookie(userId);
			return res.json({ success: true, method: 'cookie', newRoleId });
		} catch (cookieError) {
			console.error(`Cookie-Fallback fehlgeschlagen für ${userId}:`, cookieError.message);
			return res.status(500).json({
				success: false,
				error: `Beide Methoden fehlgeschlagen: ${openCloudError.message} / ${cookieError.message}`,
			});
		}
	}
};

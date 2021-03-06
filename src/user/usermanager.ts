import net from 'net'
import superagent from 'superagent'

import { ExtendedSocket } from 'extendedsocket'

import { Channel } from 'channel/channel'
import { Room } from 'room/room'

import { User } from 'user/user'
import { UserInventory } from 'user/userinventory'
import { UserSession } from 'user/usersession'

import { ChannelManager } from 'channel/channelmanager'

import { FavoritePacketType } from 'packets/favoriteshared'
import { HostPacketType } from 'packets/hostshared'
import { OptionPacketType } from 'packets/optionshared'

import { InFavoritePacket } from 'packets/in/favorite'
import { InFavoriteSetCosmetics } from 'packets/in/favorite/setcosmetics'
import { InFavoriteSetLoadout } from 'packets/in/favorite/setloadout'
import { InHostPacket } from 'packets/in/host'
import { InHostSetBuyMenu } from 'packets/in/host/setbuymenu'
import { InHostSetInventory } from 'packets/in/host/setinventory'
import { InHostSetLoadout } from 'packets/in/host/setloadout'
import { InLoginPacket } from 'packets/in/login'
import { InOptionPacket } from 'packets/in/option'
import { InOptionBuyMenu } from 'packets/in/option/buymenu'

import { OutFavoritePacket } from 'packets/out/favorite'
import { OutHostPacket } from 'packets/out/host'
import { OutInventoryPacket } from 'packets/out/inventory'
import { OutOptionPacket } from 'packets/out/option'
import { OutUserInfoPacket } from 'packets/out/userinfo'
import { OutUserStartPacket } from 'packets/out/userstart'

import { userSvcAuthority, UserSvcPing } from 'authorities'

/**
 * handles the user logic
 */
export class UserManager {

    /**
     * get the current room's object of an user's session
     * @param session the target user's session
     * @returns the room object if found, else it's null
     */
    public static getSessionCurRoom(session: UserSession): Room {
        const channel: Channel =
            ChannelManager.getChannel(session.currentChannelIndex, session.currentChannelServerIndex)

        if (channel == null) {
            return null
        }

        const currentRoom: Room = channel.getRoomById(session.currentRoomId)

        if (currentRoom == null) {
            return null
        }

        return currentRoom
    }

    /**
     * validate an user's credentials
     * @param username the user's name
     * @param password the user's password
     * @return a promise with the logged in user's ID, or zero if failed
     */
    public static async validateCredentials(username: string, password: string): Promise<number> {
        try {
            const res: superagent.Response = await superagent
                .post('http://' + userSvcAuthority() + '/users/check')
                .send({
                    username,
                    password,
                })
                .accept('json')
            return res.status === 200 ? res.body.userId : 0
        } catch (error) {
            console.error(error)
            UserSvcPing.checkNow()
            return 0
        }
    }

    /**
     * called when we receive a login request packet
     * @param loginData the login packet's data
     * @param connection the login requester's connection
     * @param server the instance to the server
     */
    public static async onLoginPacket(loginData: Buffer, connection: ExtendedSocket,
                                      holepunchPort: number): Promise<boolean> {
        const loginPacket: InLoginPacket = new InLoginPacket(loginData)

        const session: UserSession = await UserSession.create(loginPacket.gameUsername, loginPacket.password)

        // if it fails, then the user either doesn't exist or the credentials are bad
        if (session == null) {
            console.warn('Could not create session for user %s', loginPacket.gameUsername)
            connection.end()
            return false
        }

        console.log('user %s logged in (uuid: %s)', loginPacket.gameUsername, connection.uuid)

        session.externalNet.ipAddress = (connection.address() as net.AddressInfo).address
        session.update()

        connection.setOwner(session.userId)

        const user: User = await User.get(session.userId)

        if (user == null) {
            console.error('Couldn\'t get user ID %i\' information', session.userId)
            connection.end()
            return false
        }

        UserManager.sendUserInfoTo(session.userId, user.userName, user.playerName, connection, holepunchPort)
        UserManager.sendInventory(session.userId, connection)
        ChannelManager.sendChannelListTo(connection)

        return true
    }

    /**
     * handles the incoming host packets
     * @param packetData the host's packet data
     * @param connection the client's socket
     */
    public static async onHostPacket(packetData: Buffer, connection: ExtendedSocket): Promise<boolean> {
        const hostPacket: InHostPacket = new InHostPacket(packetData)

        if (connection.hasOwner() === false) {
            console.warn('connection %s sent a host packet without a session', connection.uuid)
            return false
        }

        const user: User = await User.get(connection.getOwner())

        if (user == null) {
            console.error('couldn\'t get user %i from connection %s', connection.uuid)
            return false
        }

        switch (hostPacket.packetType) {
            case HostPacketType.OnGameEnd:
                return this.onHostGameEnd(connection)
            case HostPacketType.SetInventory:
                return this.onHostSetUserInventory(hostPacket, connection)
            case HostPacketType.SetLoadout:
                return this.onHostSetUserLoadout(hostPacket, connection)
            case HostPacketType.SetBuyMenu:
                return this.onHostSetUserBuyMenu(hostPacket, connection)
        }

        console.warn('UserManager::onHostPacket: unknown host packet type %i',
            hostPacket.packetType)

        return false
    }

    public static async onHostSetUserInventory(hostPacket: InHostPacket, userConn: ExtendedSocket): Promise<boolean> {
        const preloadData: InHostSetInventory = new InHostSetInventory(hostPacket)

        const requesterId: number = userConn.getOwner()

        const results: UserSession[] = await Promise.all([
            UserSession.get(requesterId),
            UserSession.get(preloadData.userId),
        ])

        const requesterSession: UserSession = results[0]
        const targetSession: UserSession = results[1]

        if (requesterSession == null) {
            console.warn('Could not get user ID\'s %i session', requesterId)
            return false
        }

        if (requesterSession.isInRoom() === false) {
            console.warn('User ID %i tried to end a match without being in a room', requesterId)
            return false
        }

        if (targetSession == null) {
            console.warn('User ID %i tried to send its inventory to user ID %i whose session is null',
                requesterId, preloadData.userId)
            return false
        }

        const currentRoom: Room = UserManager.getSessionCurRoom(requesterSession)

        if (currentRoom == null) {
            console.error('Tried to get user\'s %i room but it couldn\'t be found. room id: %i',
                requesterSession.userId, currentRoom.id)
            return false
        }

        if (currentRoom.host.userId !== requesterId) {
            console.warn('User ID %i sent an user\'s inventory request without being the room\'s host.'
                + 'Real host ID: %i room "%s" (id %i)',
                requesterId, currentRoom.host.userId, currentRoom.settings.roomName, currentRoom.id)
            return false
        }

        await this.sendUserInventoryTo(requesterSession.userId, userConn, targetSession.userId)

        console.log('Sending user ID %i\'s inventory to host ID %i, room %s (room id %i)',
            preloadData.userId, currentRoom.host.userId, currentRoom.settings.roomName, currentRoom.id)

        return true
    }

    public static async onHostSetUserLoadout(hostPacket: InHostPacket,
                                             sourceConn: ExtendedSocket): Promise<boolean> {
        const loadoutData: InHostSetLoadout = new InHostSetLoadout(hostPacket)

        const requesterId: number = sourceConn.getOwner()

        const results: UserSession[] = await Promise.all([
            UserSession.get(requesterId),
            UserSession.get(loadoutData.userId),
        ])

        const requesterSession: UserSession = results[0]
        const targetSession: UserSession = results[1]

        if (requesterSession == null) {
            console.warn('Could not get user ID\'s %i session', requesterId)
            return false
        }

        if (requesterSession.isInRoom() === false) {
            console.warn('User ID %i tried to send loadout without being in a room', requesterId)
            return false
        }

        if (targetSession == null) {
            console.warn('User ID %i tried to send its loadout to user ID %i whose session is null',
                requesterId, loadoutData.userId)
            return false
        }

        const currentRoom: Room = this.getSessionCurRoom(requesterSession)

        if (currentRoom == null) {
            console.error('Tried to get user\'s %i room but it couldn\'t be found. room id: %i',
                requesterSession.userId, currentRoom.id)
            return false
        }

        if (currentRoom.host.userId !== requesterSession.userId) {
            console.warn('User ID %i sent an user\'s loadout request without being the room\'s host.'
                + 'Real host ID: %i room "%s" (id %i)',
                requesterSession.userId, currentRoom.host.userId, currentRoom.settings.roomName, currentRoom.id)
            return false
        }

        await this.sendUserLoadoutTo(sourceConn, targetSession.userId)

        console.log('Sending user ID %i\'s loadout to host ID %i, room %s (room id %i)',
            requesterSession.userId, currentRoom.host.userId, currentRoom.settings.roomName, currentRoom.id)

        return true
    }

    public static async onHostSetUserBuyMenu(hostPacket: InHostPacket, sourceConn: ExtendedSocket): Promise<boolean> {
        const buyMenuData: InHostSetBuyMenu = new InHostSetBuyMenu(hostPacket)

        const requesterId: number = sourceConn.getOwner()

        const results: UserSession[] = await Promise.all([
            UserSession.get(requesterId),
            UserSession.get(buyMenuData.userId),
        ])

        const requesterSession: UserSession = results[0]
        const targetSession: UserSession = results[1]

        if (requesterSession == null) {
            console.warn('Could not get user ID\'s %i session', requesterId)
            return false
        }

        if (requesterSession.isInRoom() === false) {
            console.warn('User ID %i tried to send buy menu without being in a room', requesterId)
            return false
        }

        if (targetSession == null) {
            console.warn('User ID %i tried to send its buy menu to user ID %i whose session is null',
                requesterId, buyMenuData.userId)
            return false
        }

        const currentRoom: Room = this.getSessionCurRoom(requesterSession)

        if (currentRoom == null) {
            console.error('Tried to get user\'s %i room but it couldn\'t be found. room id: %i',
                requesterSession.userId, currentRoom.id)
            return false
        }

        if (currentRoom.host.userId !== requesterId) {
            console.warn('User ID %i sent an user\'s buy menu request without being the room\'s host.'
                + 'Real host ID: %i room "%s" (id %i)',
                requesterId, currentRoom.host.userId, currentRoom.settings.roomName, currentRoom.id)
            return false
        }

        await this.sendUserBuyMenuTo(sourceConn, targetSession.userId)

        console.log('Sending user ID %i\'s buy menu to host ID %i, room %s (room id %i)',
            requesterId, currentRoom.host.userId, currentRoom.settings.roomName, currentRoom.id)

        return true
    }

    /**
     * listens for option packets
     * @param optionData the packet's data
     * @param conn the sender's connection
     */
    public static async onOptionPacket(optionData: Buffer, conn: ExtendedSocket): Promise<boolean> {
        if (conn.hasOwner() === false) {
            console.warn('uuid ' + conn.uuid + ' tried to set inventory options without a session')
            return false
        }

        const optPacket: InOptionPacket = new InOptionPacket(optionData)

        switch (optPacket.packetType) {
            case OptionPacketType.SetBuyMenu:
                return this.onOptionSetBuyMenu(optPacket, conn)
        }

        console.warn('UserManager::onOptionPacket: unknown packet type %i',
            optPacket.packetType)

        return false
    }

    public static async onOptionSetBuyMenu(optPacket: InOptionPacket,
                                           conn: ExtendedSocket): Promise<boolean> {
        const buyMenuData: InOptionBuyMenu = new InOptionBuyMenu(optPacket)
        const session: UserSession = await UserSession.get(conn.getOwner())

        if (session == null) {
            console.warn('Could not get user ID %i\'s session', conn.getOwner())
            return false
        }

        console.log('Setting user ID %i\'s buy menu', session.currentRoomId)

        await UserInventory.setBuyMenu(session.userId, buyMenuData.buyMenu)

        return true
    }

    public static async onFavoritePacket(favoriteData: Buffer, sourceConn: ExtendedSocket): Promise<boolean> {
        if (sourceConn.hasOwner() === false) {
            console.warn('uuid ' + sourceConn.uuid + ' tried to set inventory favorites without a session')
            return false
        }

        const favPacket: InFavoritePacket = new InFavoritePacket(favoriteData)

        switch (favPacket.packetType) {
            case FavoritePacketType.SetLoadout:
                return this.onFavoriteSetLoadout(favPacket, sourceConn)
            case FavoritePacketType.SetCosmetics:
                return this.onFavoriteSetCosmetics(favPacket, sourceConn)
        }

        console.warn('UserManager::onFavoritePacket: unknown packet type %i',
            favPacket.packetType)

        return false
    }

    public static async onFavoriteSetLoadout(favPacket: InFavoritePacket,
                                             sourceConn: ExtendedSocket): Promise<boolean> {
        const loadoutData: InFavoriteSetLoadout = new InFavoriteSetLoadout(favPacket)

        const session: UserSession = await UserSession.get(sourceConn.getOwner())

        if (session == null) {
            console.warn('Could not get user ID %i\'s session', sourceConn.getOwner())
            return false
        }

        const loadoutNum: number = loadoutData.loadout
        const slot: number = loadoutData.weaponSlot
        const itemId: number = loadoutData.itemId

        console.log('Setting user ID %i\'s new weapon %i to slot %i in loadout %i',
            session.currentRoomId, itemId, slot, loadoutNum)

        await UserInventory.setLoadoutWeapon(session.userId, loadoutNum, slot, itemId)

        return true
    }

    public static async onFavoriteSetCosmetics(favPacket: InFavoritePacket,
                                               sourceConn: ExtendedSocket): Promise<boolean> {
        const cosmeticsData: InFavoriteSetCosmetics = new InFavoriteSetCosmetics(favPacket)

        const session: UserSession = await UserSession.get(sourceConn.getOwner())

        if (session == null) {
            console.warn('Could not get user ID %i\'s session', sourceConn.getOwner())
            return false
        }

        const slot: number = cosmeticsData.slot
        const itemId: number = cosmeticsData.itemId

        console.log('Setting user ID %i\'s new cosmetic %i to slot %i',
            session.userId, itemId, slot)

        await UserInventory.setCosmeticSlot(session.userId, slot, itemId)

        return true
    }

    public static async onHostGameEnd(userConn: ExtendedSocket): Promise<boolean> {
        const session: UserSession = await UserSession.get(userConn.getOwner())

        if (session == null) {
            console.warn('Could not get user ID\'s %i session', userConn.getOwner())
            return false
        }

        if (session.isInRoom() === false) {
            console.warn('User ID %i tried to end a match without being in a room', userConn.getOwner())
            return false
        }

        const currentRoom: Room = UserManager.getSessionCurRoom(session)

        if (currentRoom == null) {
            console.error('Tried to get user\'s %i room but it couldn\'t be found. room id: %i',
                session.userId, currentRoom.id)
            return false
        }

        console.log('Ending game for room "%s" (room id %i)',
            currentRoom.settings.roomName, currentRoom.id)

        await currentRoom.endGame()

        return true
    }

    /**
     * send an user's info to itself
     * @param userId the target user's ID
     * @param userName the target user's name
     * @param playerName the target user's ingame name
     * @param conn the target user's connection
     * @param holepunchPort the master server's UDP holepunching port
     */
    private static async sendUserInfoTo(userId: number, userName: string, playerName: string,
                                        conn: ExtendedSocket, holepunchPort: number): Promise<void> {
        conn.send(new OutUserStartPacket(userId, userName, playerName, holepunchPort))
        conn.send(await OutUserInfoPacket.fullUserUpdate(userId))
    }

    /**
     * sends an user's inventory to itself
     * @param userId the target user's ID
     * @param conn the target user's connection
     */
    private static async sendInventory(userId: number, conn: ExtendedSocket): Promise<void> {
        const [inventory, cosmetics, loadouts, buyMenu] = await Promise.all([
            UserInventory.getInventory(userId),
            UserInventory.getCosmetics(userId),
            UserInventory.getAllLoadouts(userId),
            UserInventory.getBuyMenu(userId),
        ])

        if (inventory == null || cosmetics == null
            || loadouts == null || buyMenu == null) {
            return
        }

        conn.send(OutInventoryPacket.createInventory(inventory.items))
        /*const defaultInvReply: Buffer =
            new OutInventoryPacket(conn).addInventory(inventory.getDefaultInventory())
        conn.send(defaultInvReply)*/

        // TO BE REVERSED
        const unlockReply: Buffer = Buffer.from([0x55, 0x19, 0x5F, 0x05, 0x5A, 0x01, 0x4B, 0x00, 0x01, 0x00, 0x00,
            0x00, 0x0B, 0x00, 0x00, 0x00, 0x01, 0xE8, 0x03, 0x00, 0x00, 0x09, 0x00, 0x00, 0x00, 0x0C, 0x00,
            0x00, 0x00, 0x01, 0xDC, 0x05, 0x00, 0x00, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x00, 0x00, 0x00, 0x01,
            0xE8, 0x03, 0x00, 0x00, 0x18, 0x00, 0x00, 0x00, 0x0E, 0x00, 0x00, 0x00, 0x01, 0xDC, 0x05, 0x00,
            0x00, 0x0B, 0x00, 0x00, 0x00, 0x0F, 0x00, 0x00, 0x00, 0x01, 0x08, 0x07, 0x00, 0x00, 0x3C, 0x00,
            0x00, 0x00, 0x10, 0x00, 0x00, 0x00, 0x01, 0x80, 0xBB, 0x00, 0x00, 0x1F, 0x00, 0x00, 0x00, 0x11,
            0x00, 0x00, 0x00, 0x01, 0xC0, 0x5D, 0x00, 0x00, 0x11, 0x00, 0x00, 0x00, 0x12, 0x00, 0x00, 0x00,
            0x01, 0x08, 0x07, 0x00, 0x00, 0x1C, 0x00, 0x00, 0x00, 0x13, 0x00, 0x00, 0x00, 0x01, 0x4C, 0x1D,
            0x00, 0x00, 0x3B, 0x00, 0x00, 0x00, 0x14, 0x00, 0x00, 0x00, 0x01, 0x60, 0x61, 0x02, 0x00, 0x35,
            0x00, 0x00, 0x00, 0x15, 0x00, 0x00, 0x00, 0x01, 0x30, 0x75, 0x00, 0x00, 0x1A, 0x00, 0x00, 0x00,
            0x16, 0x00, 0x00, 0x00, 0x01, 0xA0, 0x0F, 0x00, 0x00, 0x19, 0x00, 0x00, 0x00, 0x17, 0x00, 0x00,
            0x00, 0x01, 0x98, 0x3A, 0x00, 0x00, 0x3F, 0x00, 0x00, 0x00, 0x18, 0x00, 0x00, 0x00, 0x01, 0xE0,
            0x93, 0x04, 0x00, 0x14, 0x00, 0x00, 0x00, 0x19, 0x00, 0x00, 0x00, 0x01, 0xA0, 0x0F, 0x00, 0x00,
            0x07, 0x00, 0x00, 0x00, 0x1A, 0x00, 0x00, 0x00, 0x01, 0x98, 0x3A, 0x00, 0x00, 0x3E, 0x00, 0x00,
            0x00, 0x1B, 0x00, 0x00, 0x00, 0x01, 0xE0, 0x93, 0x04, 0x00, 0x05, 0x00, 0x00, 0x00, 0x1C, 0x00,
            0x00, 0x00, 0x01, 0x08, 0x07, 0x00, 0x00, 0x2C, 0x00, 0x00, 0x00, 0x1D, 0x00, 0x00, 0x00, 0x01,
            0x30, 0x75, 0x00, 0x00, 0x10, 0x00, 0x00, 0x00, 0x1E, 0x00, 0x00, 0x00, 0x01, 0x88, 0x13, 0x00,
            0x00, 0x0C, 0x00, 0x00, 0x00, 0x1F, 0x00, 0x00, 0x00, 0x01, 0x20, 0x4E, 0x00, 0x00, 0x16, 0x00,
            0x00, 0x00, 0x20, 0x00, 0x00, 0x00, 0x01, 0x20, 0x4E, 0x00, 0x00, 0x34, 0x00, 0x00, 0x00, 0x43,
            0x00, 0x00, 0x00, 0x01, 0x30, 0x75, 0x00, 0x00, 0x46, 0x00, 0x00, 0x00, 0x57, 0x00, 0x00, 0x00,
            0x01, 0x20, 0xA1, 0x07, 0x00, 0x47, 0x00, 0x00, 0x00, 0x58, 0x00, 0x00, 0x00, 0x01, 0x20, 0xA1,
            0x07, 0x00, 0x4D, 0x00, 0x00, 0x00, 0x59, 0x00, 0x00, 0x00, 0x00, 0x90, 0x01, 0x00, 0x00, 0x55,
            0x00, 0x00, 0x00, 0x81, 0x00, 0x00, 0x00, 0x00, 0x70, 0x03, 0x00, 0x00, 0x30, 0x00, 0x00, 0x00,
            0x90, 0x00, 0x00, 0x00, 0x01, 0x30, 0x75, 0x00, 0x00, 0x1D, 0x00, 0x00, 0x00, 0x91, 0x00, 0x00,
            0x00, 0x01, 0x60, 0xEA, 0x00, 0x00, 0x20, 0x00, 0x00, 0x00, 0x92, 0x00, 0x00, 0x00, 0x01, 0x48,
            0xE8, 0x01, 0x00, 0x2F, 0x00, 0x00, 0x00, 0x93, 0x00, 0x00, 0x00, 0x01, 0x40, 0x0D, 0x03, 0x00,
            0x6A, 0xBF, 0x00, 0x00, 0xA8, 0x00, 0x00, 0x00, 0x00, 0x28, 0x00, 0x00, 0x00, 0x70, 0xBF, 0x00,
            0x00, 0xA9, 0x00, 0x00, 0x00, 0x00, 0x50, 0x00, 0x00, 0x00, 0x6F, 0xBF, 0x00, 0x00, 0xAA, 0x00,
            0x00, 0x00, 0x00, 0x28, 0x00, 0x00, 0x00, 0x6E, 0xBF, 0x00, 0x00, 0xAB, 0x00, 0x00, 0x00, 0x00,
            0x50, 0x00, 0x00, 0x00, 0x69, 0xBF, 0x00, 0x00, 0xAC, 0x00, 0x00, 0x00, 0x00, 0x28, 0x00, 0x00,
            0x00, 0x72, 0xBF, 0x00, 0x00, 0xAD, 0x00, 0x00, 0x00, 0x00, 0x50, 0x00, 0x00, 0x00, 0x6B, 0xBF,
            0x00, 0x00, 0xAE, 0x00, 0x00, 0x00, 0x00, 0x28, 0x00, 0x00, 0x00, 0x6D, 0xBF, 0x00, 0x00, 0xAF,
            0x00, 0x00, 0x00, 0x00, 0x50, 0x00, 0x00, 0x00, 0x4A, 0x00, 0x00, 0x00, 0xD7, 0x00, 0x00, 0x00,
            0x01, 0x50, 0xC3, 0x00, 0x00, 0x4B, 0x00, 0x00, 0x00, 0xD8, 0x00, 0x00, 0x00, 0x01, 0x00, 0x77,
            0x01, 0x00, 0x4E, 0x00, 0x00, 0x00, 0xE8, 0x00, 0x00, 0x00, 0x01, 0x70, 0x11, 0x01, 0x00, 0x52,
            0x00, 0x00, 0x00, 0xE9, 0x00, 0x00, 0x00, 0x01, 0xC0, 0xD4, 0x01, 0x00, 0x5B, 0x00, 0x00, 0x00,
            0x06, 0x01, 0x00, 0x00, 0x01, 0xF0, 0x49, 0x02, 0x00, 0x5F, 0x00, 0x00, 0x00, 0x19, 0x01, 0x00,
            0x00, 0x01, 0x60, 0xEA, 0x00, 0x00, 0x60, 0x00, 0x00, 0x00, 0x1A, 0x01, 0x00, 0x00, 0x01, 0xC0,
            0xD4, 0x01, 0x00, 0x64, 0x00, 0x00, 0x00, 0x38, 0x01, 0x00, 0x00, 0x01, 0xF0, 0x49, 0x02, 0x00,
            0x68, 0x00, 0x00, 0x00, 0x5C, 0x01, 0x00, 0x00, 0x01, 0x20, 0xA1, 0x07, 0x00, 0x6D, 0x00, 0x00,
            0x00, 0x82, 0x01, 0x00, 0x00, 0x01, 0xA0, 0x86, 0x01, 0x00, 0x6C, 0x00, 0x00, 0x00, 0x83, 0x01,
            0x00, 0x00, 0x01, 0xA0, 0x86, 0x01, 0x00, 0x6E, 0x00, 0x00, 0x00, 0x84, 0x01, 0x00, 0x00, 0x01,
            0xA0, 0x86, 0x01, 0x00, 0x42, 0x00, 0x00, 0x00, 0xFA, 0x01, 0x00, 0x00, 0x01, 0x30, 0x75, 0x00,
            0x00, 0x43, 0x00, 0x00, 0x00, 0xFB, 0x01, 0x00, 0x00, 0x01, 0x50, 0xC3, 0x00, 0x00, 0x78, 0x00,
            0x00, 0x00, 0xFC, 0x01, 0x00, 0x00, 0x01, 0x40, 0x0D, 0x03, 0x00, 0x79, 0x00, 0x00, 0x00, 0x07,
            0x02, 0x00, 0x00, 0x00, 0xA0, 0x00, 0x00, 0x00, 0x7C, 0x00, 0x00, 0x00, 0x08, 0x02, 0x00, 0x00,
            0x00, 0x04, 0x01, 0x00, 0x00, 0x7A, 0x00, 0x00, 0x00, 0x09, 0x02, 0x00, 0x00, 0x00, 0xE0, 0x01,
            0x00, 0x00, 0x7B, 0x00, 0x00, 0x00, 0x0A, 0x02, 0x00, 0x00, 0x00, 0x44, 0x02, 0x00, 0x00, 0x7D,
            0x00, 0x00, 0x00, 0x58, 0x02, 0x00, 0x00, 0x00, 0x44, 0x02, 0x00, 0x00, 0x7E, 0x00, 0x00, 0x00,
            0x59, 0x02, 0x00, 0x00, 0x00, 0x0C, 0x03, 0x00, 0x00, 0x81, 0x00, 0x00, 0x00, 0x91, 0x02, 0x00,
            0x00, 0x01, 0xF0, 0x49, 0x02, 0x00, 0x82, 0x00, 0x00, 0x00, 0x92, 0x02, 0x00, 0x00, 0x01, 0x00,
            0x53, 0x07, 0x00, 0x83, 0x00, 0x00, 0x00, 0x93, 0x02, 0x00, 0x00, 0x01, 0x60, 0x5B, 0x03, 0x00,
            0x85, 0x00, 0x00, 0x00, 0x94, 0x02, 0x00, 0x00, 0x00, 0x40, 0x01, 0x00, 0x00, 0x84, 0x00, 0x00,
            0x00, 0x95, 0x02, 0x00, 0x00, 0x00, 0x08, 0x02, 0x00, 0x00, 0x87, 0x00, 0x00, 0x00, 0x1F, 0x03,
            0x00, 0x00, 0x00, 0x08, 0x02, 0x00, 0x00, 0x8A, 0x00, 0x00, 0x00, 0xA4, 0x03, 0x00, 0x00, 0x01,
            0xE0, 0x93, 0x04, 0x00, 0x8F, 0x00, 0x00, 0x00, 0x44, 0x04, 0x00, 0x00, 0x01, 0x80, 0xA9, 0x03,
            0x00, 0x90, 0x00, 0x00, 0x00, 0x45, 0x04, 0x00, 0x00, 0x01, 0x40, 0x7E, 0x05, 0x00, 0x91, 0x00,
            0x00, 0x00, 0x46, 0x04, 0x00, 0x00, 0x01, 0x00, 0x53, 0x07, 0x00, 0x9B, 0x00, 0x00, 0x00, 0xA9,
            0x04, 0x00, 0x00, 0x01, 0xF0, 0x49, 0x02, 0x00, 0x9C, 0x00, 0x00, 0x00, 0xAA, 0x04, 0x00, 0x00,
            0x01, 0x40, 0x0D, 0x03, 0x00, 0x97, 0x00, 0x00, 0x00, 0xFC, 0x04, 0x00, 0x00, 0x01, 0x42, 0x99,
            0x00, 0x00, 0x98, 0x00, 0x00, 0x00, 0xFD, 0x04, 0x00, 0x00, 0x01, 0x86, 0x29, 0x02, 0x00, 0x99,
            0x00, 0x00, 0x00, 0xFE, 0x04, 0x00, 0x00, 0x01, 0x8C, 0xED, 0x02, 0x00, 0x10, 0x00, 0x03, 0x00,
            0x00, 0x00, 0x10, 0x00, 0x00, 0x00, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x42, 0x00, 0x00, 0x00, 0x43, 0x00, 0x00, 0x00, 0x06, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x0E, 0x00, 0x00, 0x00, 0x14, 0x00, 0x00, 0x00, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x0F, 0x00, 0x00, 0x00, 0x0A, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x00, 0x00, 0x16, 0x00, 0x00, 0x00, 0x07, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x00, 0x00, 0x0C, 0x00, 0x00, 0x00,
            0x07, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x11, 0x00, 0x00, 0x00, 0x1C, 0x00,
            0x00, 0x00, 0x05, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x11, 0x00, 0x00, 0x00,
            0x35, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x12, 0x00,
            0x00, 0x00, 0x34, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x13, 0x00, 0x00, 0x00, 0x4D, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x13, 0x00, 0x00, 0x00, 0x05, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x14, 0x00, 0x00, 0x00, 0x07, 0x00, 0x00, 0x00, 0x08, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x14, 0x00, 0x00, 0x00, 0x3E, 0x00, 0x00, 0x00, 0x08, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x15, 0x00, 0x00, 0x00, 0x11, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x1A, 0x00, 0x00, 0x00, 0x3F, 0x00,
            0x00, 0x00, 0x1A, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x1A, 0x00, 0x00, 0x00,
            0x19, 0x00, 0x00, 0x00, 0x1A, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x19, 0x00,
            0x01, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x03, 0x00, 0x00, 0x00, 0x05, 0x00, 0x00, 0x00,
            0x06, 0x00, 0x00, 0x00, 0x07, 0x00, 0x00, 0x00, 0x09, 0x00, 0x00, 0x00, 0x0A, 0x00, 0x00, 0x00,
            0x0B, 0x00, 0x00, 0x00, 0x0D, 0x00, 0x00, 0x00, 0x0E, 0x00, 0x00, 0x00, 0x0F, 0x00, 0x00, 0x00,
            0x10, 0x00, 0x00, 0x00, 0x11, 0x00, 0x00, 0x00, 0x12, 0x00, 0x00, 0x00, 0x13, 0x00, 0x00, 0x00,
            0x14, 0x00, 0x00, 0x00, 0x15, 0x00, 0x00, 0x00, 0x18, 0x00, 0x00, 0x00, 0x19, 0x00, 0x00, 0x00,
            0x1A, 0x00, 0x00, 0x00, 0x1C, 0x00, 0x00, 0x00, 0x6C, 0xBF, 0x00, 0x00, 0x71, 0xBF, 0x00, 0x00,
            0x42, 0x00, 0x00, 0x00, 0x94, 0x01, 0x00, 0x00])
        conn.sendBuffer(unlockReply)
        conn.send(OutFavoritePacket.setCosmetics(cosmetics.ctItem, cosmetics.terItem,
                cosmetics.headItem, cosmetics.gloveItem, cosmetics.backItem, cosmetics.stepsItem,
                cosmetics.cardItem, cosmetics.sprayItem))
        conn.send(OutFavoritePacket.setLoadout(loadouts))
        conn.send(OutOptionPacket.setBuyMenu(buyMenu))
    }

    /**
     * send the host an user's inventory
     * @param hostUserId the target host's user ID
     * @param hostConn the target host's connection
     * @param targetUserId the target user's ID session
     */
    private static async sendUserInventoryTo(hostUserId: number, hostConn: ExtendedSocket,
                                             targetUserId: number): Promise<void> {
        const inventory: UserInventory = await UserInventory.getInventory(hostUserId)
        hostConn.send(OutHostPacket.setInventory(targetUserId, inventory.items))
    }

    /**
     * send the host an user's loadout
     * @param hostConn the target host's connection
     * @param targetUserId the target user's ID session
     */
    private static async sendUserLoadoutTo(hostConn: ExtendedSocket, targetUserId: number): Promise<void> {
        hostConn.send(await OutHostPacket.setLoadout(targetUserId))
    }

    /**
     * send the host an user's loadout
     * @param hostUserId the target host's user ID
     * @param hostConn the target host's connection
     * @param targetUserId the target user's ID session
     */
    private static async sendUserBuyMenuTo(hostConn: ExtendedSocket, targetUserId: number): Promise<void> {
        hostConn.send(await OutHostPacket.setBuyMenu(targetUserId))
    }
}

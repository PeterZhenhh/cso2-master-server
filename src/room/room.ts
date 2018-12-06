import { Channel } from 'channel/channel'
import { User } from 'user/user'

import { OutRoomPacket } from 'packets/out/room'
import { UserInfoFullUpdate } from 'packets/out/userinfo/fulluserupdate';

export interface IRoomOptions {
    roomName?: string,
    gameModeId?: number,
    mapId?: number,
    winLimit?: number,
    killLimit?: number,
    startMoney?: number,
    forceCamera?: number,
    nextMapEnabled?: number,
    changeTeams?: number,
    enableBots?: number,
    difficulty?: number
    respawnTime?: number
    teamBalance?: number
    weaponRestrictions?: number
    hltvEnabled?: number
}

export class Room {
    public id: number
    public roomName: string
    public maxPlayers: number
    public gameModeId: number
    public mapId: number
    public winLimit: number
    public killLimit: number
    public startMoney: number
    public forceCamera: number
    public nextMapEnabled: number
    public changeTeams: number
    public enableBots: number
    public difficulty: number
    public respawnTime: number
    public teamBalance: number
    public weaponRestrictions: number
    public hltvEnabled: number

    public host: User
    public users: User[]

    private emptyRoomCallback: (emptyRoom: Room, channel: Channel) => void
    private parentChannel: Channel

    constructor(roomId: number, host: User, parentChannel: Channel,
                emptyRoomCallback?: (emptyRoom: Room, channel: Channel) => void,
                options?: IRoomOptions) {
        this.id = roomId
        this.host = host

        this.parentChannel = parentChannel
        this.emptyRoomCallback = emptyRoomCallback

        this.roomName = options.roomName ? options.roomName : 'Room #' + this.id
        this.gameModeId = options.gameModeId ? options.gameModeId : 0
        this.mapId = options.mapId ? options.mapId : 1
        this.winLimit = options.winLimit ? options.winLimit : 10
        this.killLimit = options.killLimit ? options.killLimit : 150
        this.startMoney = options.startMoney ? options.startMoney : 16000
        this.forceCamera = options.forceCamera ? options.forceCamera : 1
        this.nextMapEnabled = options.nextMapEnabled ? options.nextMapEnabled : 0
        this.changeTeams = options.changeTeams ? options.changeTeams : 0
        this.enableBots = options.enableBots ? options.enableBots : 0
        this.difficulty = options.difficulty ? options.difficulty : 0
        this.maxPlayers = options.enableBots ? 16 : 32
        this.respawnTime = options.respawnTime ? options.respawnTime : 3
        this.teamBalance = options.teamBalance ? options.teamBalance : 0
        this.weaponRestrictions = options.weaponRestrictions ? options.weaponRestrictions : 0
        this.hltvEnabled = options.hltvEnabled ? options.hltvEnabled : 0

        this.users = []
        this.addUser(host)
    }

    /**
     * returns the ammount of player slots available in the room
     * @returns the free player slots
     */
    public getFreeSlots(): number {
        const availableSlots: number = this.maxPlayers - this.users.length
        return availableSlots >= 0 ? availableSlots : 0
    }

    /**
     * does this room have free player slots?
     */
    public hasFreeSlots(): boolean {
        return this.getFreeSlots() !== 0
    }

    /**
     * add an user to a room
     * @param user the user object to add
     */
    public addUser(user: User): void {
        this.users.push(user)
    }

    /**
     * remove an user from a room
     * @param targetUser the user object to remove
     */
    public removeUser(targetUser: User): void {
        for (const user of this.users) {
            if (user === targetUser) {
                const userId = user.userId
                this.users.splice(this.users.indexOf(user), 1)
                this.onUserRemoved(userId)
                return
            }
        }
    }

    /**
     * remove an user from a room by its user id
     * @param targetUser the user's id to remove
     */
    public removeUserById(userId: number): void {
        for (const user of this.users) {
            if (user.userId === userId) {
                this.users.splice(this.users.indexOf(user), 1)
                this.onUserRemoved(userId)
                return
            }
        }
    }

    /**
     * called when an user is succesfully removed
     * if the room is empty, inform the channel to delete us
     * else, find a new host
     */
    private onUserRemoved(userId: number): void {
        if (this.users.length === 0) {
            this.emptyRoomCallback(this, this.parentChannel)
        } else {
            this.findAndUpdateNewHost()
            this.sendRemovedUser(userId)
        }
    }

    /**
     * inform the users about an user being removed
     * @param userId the removed user's ID
     */
    private sendRemovedUser(userId: number) {
        for (const user of this.users) {
            const reply: Buffer =
                new OutRoomPacket(user.socket.getSeq())
                    .playerLeave(userId);
            user.socket.write(reply)
        }
    }

    /**
     * sets the new room host and tells the users about it
     * @param newHost the new host user
     */
    private updateHost(newHost: User): void {
        this.host = newHost

        for (const user of this.users) {
            const reply: Buffer =
                new OutRoomPacket(user.socket.getSeq())
                    .setHost(this.host)
            user.socket.write(reply)
        }
    }

    /**
     * assign the first available user as a host,
     * and updates the users about it
     * only if the room isn't empty
     * @returns true if a new host was found, false if not
     */
    private findAndUpdateNewHost(): boolean {
        if (this.users.length === 0) {
            return false
        }

        this.updateHost(this.users[0])
        return true
    }
}
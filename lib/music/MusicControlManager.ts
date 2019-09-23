import {
    PlayerType,
    play,
    pause,
    previous,
    next,
    PlayerName,
    Track,
    setItunesLoved,
    launchPlayer,
    PlaylistItem,
    playTrackInContext,
    TrackStatus,
    playTrack,
    saveToSpotifyLiked,
    removeFromSpotifyLiked
} from "cody-music";
import { window, ViewColumn, Uri, commands } from "vscode";
import { MusicCommandManager } from "./MusicCommandManager";
import { showQuickPick } from "../MenuManager";
import {
    getUserStatus,
    serverIsAvailable,
    refetchSpotifyConnectStatusLazily,
    getLoggedInCacheState,
    getAppJwt
} from "../DataController";
import {
    getItem,
    getMusicTimeFile,
    isLinux,
    logIt,
    launchWebUrl,
    launchLogin,
    createSpotifyIdFromUri,
    getMusicTimeMarkdownFile,
    getSoftwareDir,
    setItem
} from "../Util";
import { softwareGet, softwarePut, isResponseOk } from "../HttpClient";
import {
    api_endpoint,
    LOGIN_LABEL,
    REFRESH_CUSTOM_PLAYLIST_TITLE,
    GENERATE_CUSTOM_PLAYLIST_TITLE,
    REFRESH_CUSTOM_PLAYLIST_TOOLTIP,
    GENERATE_CUSTOM_PLAYLIST_TOOLTIP,
    SPOTIFY_LIKED_SONGS_PLAYLIST_NAME,
    PERSONAL_TOP_SONGS_PLID,
    NOT_NOW_LABEL,
    YES_LABEL
} from "../Constants";
import { MusicStateManager } from "./MusicStateManager";
import { SocialShareManager } from "../social/SocialShareManager";
import { tmpdir } from "os";
import { connectSlack } from "../slack/SlackControlManager";
import { MusicManager } from "./MusicManager";
const moment = require("moment-timezone");
const clipboardy = require("clipboardy");
const fs = require("fs");

const NO_DATA = "MUSIC TIME\n\nNo data available\n";

let lastDayOfMonth = -1;
let fetchingMusicTimeMetrics = false;

export class MusicControlManager {
    private musicMgr: MusicManager = MusicManager.getInstance();
    private musicStateMgr: MusicStateManager = MusicStateManager.getInstance();

    constructor() {
        //
    }

    async nextSong(playerName: PlayerName = null) {
        if (!playerName) {
            playerName = this.musicMgr.currentPlayerName;
        }
        await next(playerName);
        await this.musicStateMgr.musicStateCheck();
    }

    async previousSong(playerName: PlayerName = null) {
        if (!playerName) {
            playerName = this.musicMgr.currentPlayerName;
        }
        await previous(playerName);
        await this.musicStateMgr.musicStateCheck();
    }

    async playSong(playerName: PlayerName = null) {
        if (!playerName) {
            playerName = this.musicMgr.currentPlayerName;
        }
        await play(playerName);
        this.musicMgr.runningTrack.state = TrackStatus.Playing;
        MusicCommandManager.syncControls(this.musicMgr.runningTrack);
    }

    async pauseSong(playerName: PlayerName = null) {
        if (!playerName) {
            playerName = this.musicMgr.currentPlayerName;
        }
        await pause(playerName);
        this.musicMgr.runningTrack.state = TrackStatus.Paused;
        MusicCommandManager.syncControls(this.musicMgr.runningTrack);
    }

    async playSongInContext(params) {
        await playTrackInContext(this.musicMgr.currentPlayerName, params);
    }

    async playSongById(playerName: PlayerName, trackId: string) {
        await playTrack(playerName, trackId);
    }

    async setLiked(liked: boolean) {
        let track: Track = this.musicMgr.runningTrack;
        if (track) {
            // update the state right away. perform the api update asyn
            track.loved = liked;
            this.musicMgr.runningTrack = track;
            MusicCommandManager.syncControls(track);

            let refreshPlaylist = false;
            if (track.playerType === PlayerType.MacItunesDesktop) {
                // await so that the stateCheckHandler fetches
                // the latest version of the itunes track
                await setItunesLoved(liked).catch(err => {
                    logIt(`Error updating itunes loved state: ${err.message}`);
                });
            } else {
                // save the spotify track to the users liked songs playlist
                if (liked) {
                    await saveToSpotifyLiked([track.id]);
                } else {
                    await removeFromSpotifyLiked([track.id]);
                }
                refreshPlaylist = true;
            }

            let type = "spotify";
            if (track.playerType === PlayerType.MacItunesDesktop) {
                type = "itunes";
            }
            const api = `/music/liked/track/${track.id}?type=${type}`;
            const resp = await softwarePut(api, { liked }, getItem("jwt"));
            if (!isResponseOk(resp)) {
                logIt(`Error updating track like state: ${resp.message}`);
            }

            this.musicMgr.getServerTrack(track);

            if (refreshPlaylist) {
                commands.executeCommand("musictime.refreshPlaylist");
            }
        }
    }

    async copySpotifyLink(id: string, isPlaylist: boolean) {
        let link = buildSpotifyLink(id, isPlaylist);

        if (id === SPOTIFY_LIKED_SONGS_PLAYLIST_NAME) {
            link = "https://open.spotify.com/collection/tracks";
        }

        let messageContext = "";
        if (isPlaylist) {
            messageContext = "playlist";
        } else {
            messageContext = "track";
        }

        try {
            clipboardy.writeSync(link);
            window.showInformationMessage(
                `Spotify ${messageContext} link copied to clipboard.`,
                ...["OK"]
            );
        } catch (err) {
            logIt(`Unable to copy to clipboard, error: ${err.message}`);
        }
    }

    copyCurrentTrackLink() {
        // example: https://open.spotify.com/track/7fa9MBXhVfQ8P8Df9OEbD8
        // get the current track
        const selectedItem: PlaylistItem = MusicManager.getInstance()
            .selectedTrackItem;
        this.copySpotifyLink(selectedItem.id, false);
    }

    copyCurrentPlaylistLink() {
        // example: https://open.spotify.com/playlist/0mwG8hCL4scWi8Nkt7jyoV
        const selectedItem: PlaylistItem = MusicManager.getInstance()
            .selectedPlaylist;
        this.copySpotifyLink(selectedItem.id, true);
    }

    shareCurrentPlaylist() {
        const socialShare: SocialShareManager = SocialShareManager.getInstance();
        const selectedItem: PlaylistItem = MusicManager.getInstance()
            .selectedPlaylist;
        const url = buildSpotifyLink(selectedItem.id, true);

        socialShare.shareIt("facebook", { u: url, hashtag: "OneOfMyFavs" });
    }

    launchSpotifyPlayer() {
        window.showInformationMessage(
            `After you select and play your first song in Spotify, standard controls (play, pause, next, etc.) will appear in your status bar.`,
            ...["OK"]
        );
        setTimeout(() => {
            launchPlayer(PlayerName.SpotifyWeb);
        }, 3200);
    }

    async showMenu() {
        let loggedInCacheState = getLoggedInCacheState();
        let serverIsOnline = await serverIsAvailable();
        let userStatus = {
            loggedIn: loggedInCacheState
        };
        if (loggedInCacheState === null) {
            // update it since it's null
            // {loggedIn: true|false}
            userStatus = await getUserStatus(serverIsOnline);
        }

        // let loginFunction = launchLogin;
        // let loginMsgDetail =
        //     "To see your music data in Music Time, please log in to your account";
        // if (!serverIsOnline) {
        //     loginMsgDetail =
        //         "Our service is temporarily unavailable. Please try again later.";
        //     loginFunction = null;
        // }

        let menuOptions = {
            items: []
        };

        const musicMgr: MusicManager = MusicManager.getInstance();

        // check if the user has the spotify_access_token
        const accessToken = getItem("spotify_access_token");
        const slackAccessToken = getItem("slack_access_token");

        if (accessToken) {
            // check if we already have a playlist
            const savedPlaylists: PlaylistItem[] = musicMgr.savedPlaylists;
            const hasSavedPlaylists =
                savedPlaylists && savedPlaylists.length > 0 ? true : false;

            const codingFavs: any[] = musicMgr.userTopSongs;
            const hasUserFavorites =
                codingFavs && codingFavs.length > 0 ? true : false;

            const customPlaylist = musicMgr.getMusicTimePlaylistByTypeId(
                PERSONAL_TOP_SONGS_PLID
            );

            let personalPlaylistLabel = !customPlaylist
                ? GENERATE_CUSTOM_PLAYLIST_TITLE
                : REFRESH_CUSTOM_PLAYLIST_TITLE;
            const personalPlaylistTooltip = !customPlaylist
                ? GENERATE_CUSTOM_PLAYLIST_TOOLTIP
                : REFRESH_CUSTOM_PLAYLIST_TOOLTIP;

            if (!hasSavedPlaylists && hasUserFavorites) {
                // show the generate playlist menu item
                menuOptions.items.push({
                    label: personalPlaylistLabel,
                    detail: personalPlaylistTooltip,
                    cb: musicMgr.generateUsersWeeklyTopSongs
                });
            }
        }

        // if (!userStatus.loggedIn) {
        //     menuOptions.items.push({
        //         label: LOGIN_LABEL,
        //         detail: loginMsgDetail,
        //         cb: loginFunction
        //     });
        // }

        menuOptions.items.push({
            label: "Music Time Dashboard",
            detail: "View your latest music metrics right here in your editor",
            cb: displayMusicTimeMetricsMarkdownDashboard
        });

        menuOptions.items.push({
            label: "Submit an issue on GitHub",
            detail: "Encounter a bug? Submit an issue on our GitHub page",
            url: "https://github.com/swdotcom/swdc-vscode/issues"
        });

        menuOptions.items.push({
            label: "Submit Feedback",
            detail: "Send us an email at cody@software.com.",
            url: "mailto:cody@software.com"
        });

        if (serverIsOnline) {
            // show divider
            menuOptions.items.push({
                label:
                    "___________________________________________________________________",
                cb: null,
                url: null,
                command: null
            });

            if (!accessToken) {
                menuOptions.items.push({
                    label: "Connect Spotify",
                    detail:
                        "To see your Spotify playlists in Music Time, please connect your account",
                    url: null,
                    cb: connectSpotify
                });
            } else {
                menuOptions.items.push({
                    label: "Disconnect Spotify",
                    detail: "Disconnect your Spotify oauth integration",
                    url: null,
                    command: "musictime.disconnectSpotify"
                });
            }
            if (!slackAccessToken) {
                menuOptions.items.push({
                    label: "Connect Slack",
                    detail:
                        "To share a playlist or track on Slack, please connect your account",
                    url: null,
                    cb: connectSlack
                });
            } else {
                menuOptions.items.push({
                    label: "Disconnect Slack",
                    detail: "Disconnect your Slack oauth integration",
                    url: null,
                    command: "musictime.disconnectSlack"
                });
            }
        }

        showQuickPick(menuOptions);
    }
}

export function buildSpotifyLink(id: string, isPlaylist: boolean) {
    let link = "";
    id = createSpotifyIdFromUri(id);
    if (isPlaylist) {
        link = `https://open.spotify.com/playlist/${id}`;
    } else {
        link = `https://open.spotify.com/track/${id}`;
    }

    return link;
}

export async function displayMusicTimeMetricsMarkdownDashboard() {
    if (fetchingMusicTimeMetrics) {
        window.showInformationMessage(
            `Still building Music Time dashboard, please wait...`
        );
        return;
    }
    fetchingMusicTimeMetrics = true;

    window.showInformationMessage(
        `Building Music Time dashboard, please wait...`
    );

    const musicTimeFile = getMusicTimeMarkdownFile();
    await fetchMusicTimeMetricsMarkdownDashboard();

    const viewOptions = {
        viewColumn: ViewColumn.One,
        preserveFocus: false
    };
    const localResourceRoots = [Uri.file(getSoftwareDir()), Uri.file(tmpdir())];
    const panel = window.createWebviewPanel(
        "music-time-preview",
        `Music Time Dashboard`,
        viewOptions,
        {
            enableFindWidget: true,
            localResourceRoots,
            enableScripts: true // enables javascript that may be in the content
        }
    );

    const content = fs.readFileSync(musicTimeFile).toString();
    panel.webview.html = content;

    window.showInformationMessage(`Completed building Music Time dashboard.`);
    fetchingMusicTimeMetrics = false;
}

export async function connectSpotify() {
    let serverIsOnline = await serverIsAvailable();
    if (!serverIsOnline) {
        window.showInformationMessage(
            `Our service is temporarily unavailable.\n\nPlease try again later.\n`
        );
        return;
    }
    let jwt = getItem("jwt");
    if (!jwt) {
        jwt = await getAppJwt(true);
        await setItem("jwt", jwt);
    }
    const endpoint = `${api_endpoint}/auth/spotify?token=${jwt}`;
    launchWebUrl(endpoint);
    refetchSpotifyConnectStatusLazily();
}

export async function disconnectSpotify() {
    disconnectOauth("Spotify");
}

export async function disconnectSlack() {
    disconnectOauth("Slack");
}

export async function disconnectOauth(type: string) {
    const selection = await window.showInformationMessage(
        `Are you sure you would like to disconnect ${type}?`,
        ...[NOT_NOW_LABEL, YES_LABEL]
    );

    if (selection === YES_LABEL) {
        let serverIsOnline = await serverIsAvailable();
        if (serverIsOnline) {
            const type_lc = type.toLowerCase();
            let result = await softwarePut(
                `/auth/${type_lc}/disconnect`,
                {},
                getItem("jwt")
            );

            if (isResponseOk(result)) {
                const musicMgr = MusicManager.getInstance();
                // oauth is not null, initialize spotify
                if (type_lc === "slack") {
                    await MusicManager.getInstance().updateSlackAccessInfo(
                        null
                    );
                } else if (type_lc === "spotify") {
                    musicMgr.clearSpotifyAccessInfo();
                }

                // refresh the playlist
                setTimeout(() => {
                    commands.executeCommand("musictime.refreshPlaylist");
                }, 1000);
            }
        } else {
            window.showInformationMessage(
                `Our service is temporarily unavailable.\n\nPlease try again later.\n`
            );
        }
    }
}

export async function fetchMusicTimeMetricsMarkdownDashboard() {
    let file = getMusicTimeMarkdownFile();

    const dayOfMonth = moment()
        .startOf("day")
        .date();
    if (!fs.existsSync(file) || lastDayOfMonth !== dayOfMonth) {
        lastDayOfMonth = dayOfMonth;
        await fetchDashboardData(file, "music-time", true);
    }
}

export async function fetchMusicTimeMetricsDashboard() {
    let file = getMusicTimeFile();

    const dayOfMonth = moment()
        .startOf("day")
        .date();
    if (fs.existsSync(file) || lastDayOfMonth !== dayOfMonth) {
        lastDayOfMonth = dayOfMonth;
        await fetchDashboardData(file, "music-time", false);
    }
}

async function fetchDashboardData(
    fileName: string,
    plugin: string,
    isHtml: boolean
) {
    const musicSummary = await softwareGet(
        `/dashboard?plugin=${plugin}&linux=${isLinux()}&html=${isHtml}`,
        getItem("jwt")
    );

    // get the content
    let content =
        musicSummary && musicSummary.data ? musicSummary.data : NO_DATA;

    fs.writeFileSync(fileName, content, err => {
        if (err) {
            logIt(
                `Error writing to the Software dashboard file: ${err.message}`
            );
        }
    });
}

import { addFilter } from '@wordpress/hooks';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import * as awarenessProtocol from 'y-protocols/awareness';

const MSG_SYNC = 0;
const MSG_AWARENESS = 1;
const SYNC_STEP1 = 0;
const SYNC_STEP2 = 1;
const SYNC_UPDATE = 2;

const config = window.wpCollabCf || {};

if ( config.wsUrl ) {
	addFilter(
		'sync.providers',
		'wp-collab-cf/websocket-provider',
		() => {
			return [
				async ( { objectType, objectId, ydoc, awareness } ) => {
					// Grab Yjs from wp-sync's public exports.
					const Y = window.wp?.sync?.Y;
					if ( ! Y ) {
						// eslint-disable-next-line no-console
						console.error( 'WP Collab CF: wp.sync.Y not found — wp-sync may not be loaded.' );
						return { destroy: () => {}, on: () => {} };
					}

					const room = `${ objectType.replace( /\//g, '-' ) }-${
						objectId ?? 'collection'
					}`;
					const wsUrl = `${ config.wsUrl }/parties/collaboration/${ room }`;

					let ws;
					let connected = false;
					let destroyed = false;
					const statusCallbacks = [];

					// Gutenberg tears its sync entity down and rebuilds it several
					// times while the editor boots, and every rebuild is a fresh
					// Y.Doc — so a fresh awareness identity for the same person.
					// Announcing presence the instant we connect made each of those
					// throwaway identities show up as its own collaborator avatar in
					// everyone else's window, then vanish a moment later. Waiting
					// until a connection has proven it will survive means the
					// short-lived ones never announce at all. Document sync is NOT
					// delayed — only presence.
					const PRESENCE_SETTLE_MS = 1500;
					let presenceReady = false;
					let presenceTimer;

					function sendMsg( buf ) {
						if ( ws && ws.readyState === WebSocket.OPEN ) {
							ws.send( buf );
						}
					}

					// -- Sync protocol helpers --

					function sendSyncStep1() {
						const enc = encoding.createEncoder();
						encoding.writeVarUint( enc, MSG_SYNC );
						encoding.writeVarUint( enc, SYNC_STEP1 );
						encoding.writeVarUint8Array(
							enc,
							Y.encodeStateVector( ydoc )
						);
						sendMsg( encoding.toUint8Array( enc ) );
					}

					function sendSyncStep2( sv ) {
						const enc = encoding.createEncoder();
						encoding.writeVarUint( enc, MSG_SYNC );
						encoding.writeVarUint( enc, SYNC_STEP2 );
						encoding.writeVarUint8Array(
							enc,
							Y.encodeStateAsUpdate( ydoc, sv )
						);
						sendMsg( encoding.toUint8Array( enc ) );
					}

					function sendUpdate( update ) {
						const enc = encoding.createEncoder();
						encoding.writeVarUint( enc, MSG_SYNC );
						encoding.writeVarUint( enc, SYNC_UPDATE );
						encoding.writeVarUint8Array( enc, update );
						sendMsg( encoding.toUint8Array( enc ) );
					}

					function handleSyncMessage( dec ) {
						const syncType = decoding.readVarUint( dec );
						switch ( syncType ) {
							case SYNC_STEP1: {
								const sv = decoding.readVarUint8Array( dec );
								sendSyncStep2( sv );
								break;
							}
							case SYNC_STEP2:
							case SYNC_UPDATE: {
								const update = decoding.readVarUint8Array( dec );
								Y.applyUpdate( ydoc, update, 'ws-provider' );
								break;
							}
						}
					}

					// -- Awareness --

					function sendAwareness( changedClients ) {
						const enc = encoding.createEncoder();
						encoding.writeVarUint( enc, MSG_AWARENESS );
						encoding.writeVarUint8Array(
							enc,
							awarenessProtocol.encodeAwarenessUpdate(
								awareness,
								changedClients
							)
						);
						sendMsg( encoding.toUint8Array( enc ) );
					}

					// Collapse multiple awareness identities that belong to the same
					// WordPress user down to one.
					//
					// Gutenberg keys its collaborator list by awareness clientID and
					// mints a fresh Y.Doc (so a fresh clientID) every time it rebuilds
					// its sync entity — which it does several times while the editor
					// boots, and again on every reload. One person therefore occupies
					// several slots and shows up as repeated avatars. The awareness
					// state carries the real user in `collaboratorInfo.id`, so we can
					// tell those apart from genuinely different people.
					//
					// Winner is the newest provider (largest `enteredAt`), with our own
					// clientID always winning: dropping our own local state would
					// remove us from everyone else's list.
					function dedupeCollaborators() {
						if ( ! awareness ) {
							return;
						}
						const bestByUser = new Map();
						const drop = [];

						awareness.getStates().forEach( ( state, clientID ) => {
							const info = state?.collaboratorInfo;
							if ( ! info || info.id === undefined ) {
								return;
							}
							// Never let our own entry lose.
							const rank =
								clientID === awareness.clientID
									? Infinity
									: info.enteredAt ?? 0;
							const best = bestByUser.get( info.id );
							if ( ! best ) {
								bestByUser.set( info.id, { clientID, rank } );
								return;
							}
							if ( rank > best.rank ) {
								drop.push( best.clientID );
								bestByUser.set( info.id, { clientID, rank } );
							} else {
								drop.push( clientID );
							}
						} );

						if ( drop.length ) {
							// Origin 'dedupe' — onAwarenessUpdate must not broadcast
							// this. It is a local display decision; other peers may
							// still legitimately see those clients.
							awarenessProtocol.removeAwarenessStates(
								awareness,
								drop,
								'dedupe'
							);
						}
					}

					// -- Doc & awareness event handlers --

					const onDocUpdate = ( update, origin ) => {
						if ( origin !== 'ws-provider' ) {
							sendUpdate( update );
						}
					};

					// Announce this client's presence, and allow later changes through.
					function announcePresence() {
						presenceReady = true;
						if ( awareness ) {
							// Sends whatever the local state is *now*, so nothing that
							// changed during the settle window is lost.
							sendAwareness( [ awareness.clientID ] );
						}
					}

					const onAwarenessUpdate = (
						{ added, updated, removed },
						origin
					) => {
						// Don't echo back what a peer just told us — the relay already
						// fanned that frame out to everyone. Re-sending it only wastes
						// a round trip (peers drop it on the clock check anyway).
						if ( origin === 'ws-provider' ) {
							return;
						}
						// Never broadcast a local dedupe: telling other peers to drop a
						// client we merely chose not to display would evict someone who
						// is alive and well from their lists too.
						if ( origin === 'dedupe' ) {
							return;
						}
						// Stay silent until this connection has settled.
						if ( ! presenceReady ) {
							return;
						}
						const changed = added.concat( updated, removed );
						sendAwareness( changed );
					};

					ydoc.on( 'update', onDocUpdate );
					if ( awareness ) {
						awareness.on( 'update', onAwarenessUpdate );
					}

					// -- WebSocket connection --

					function connect() {
						if ( destroyed ) {
							return;
						}
						ws = new WebSocket( wsUrl );
						ws.binaryType = 'arraybuffer';

						ws.addEventListener( 'open', () => {
							connected = true;
							statusCallbacks.forEach( ( cb ) =>
								cb( { status: 'connected' } )
							);
							sendSyncStep1();
							// ...and announce our full state, unsolicited. Any peer
							// already in the room sent its step1 before we arrived, so
							// it will never ask us for our state — and Yjs silently
							// parks updates whose history it is missing (pending
							// structs). That is what makes edits sync one way only.
							sendSyncStep2(); // no state vector => whole document
							if ( awareness ) {
								presenceTimer = setTimeout(
									announcePresence,
									PRESENCE_SETTLE_MS
								);
							}
						} );

						ws.addEventListener( 'message', ( event ) => {
							const data = new Uint8Array( event.data );
							const dec = decoding.createDecoder( data );
							const msgType = decoding.readVarUint( dec );

							switch ( msgType ) {
								case MSG_SYNC:
									handleSyncMessage( dec );
									break;
								case MSG_AWARENESS:
									if ( awareness ) {
										const update =
											decoding.readVarUint8Array( dec );
										awarenessProtocol.applyAwarenessUpdate(
											awareness,
											update,
											'ws-provider'
										);
										// Same task as the apply, so the duplicate is
										// gone before anything can render it.
										dedupeCollaborators();
									}
									break;
							}
						} );

						ws.addEventListener( 'close', () => {
							connected = false;
							// A reconnect has to earn its presence again.
							presenceReady = false;
							clearTimeout( presenceTimer );
							statusCallbacks.forEach( ( cb ) =>
								cb( { status: 'disconnected' } )
							);
							if ( ! destroyed ) {
								setTimeout( connect, 2000 );
							}
						} );

						ws.addEventListener( 'error', () => {
							ws.close();
						} );
					}

					connect();

					return {
						destroy: () => {
							destroyed = true;
							clearTimeout( presenceTimer );
							ydoc.off( 'update', onDocUpdate );
							if ( awareness ) {
								awareness.off( 'update', onAwarenessUpdate );
								awarenessProtocol.removeAwarenessStates(
									awareness,
									[ awareness.clientID ],
									'provider-destroy'
								);
							}
							if ( ws ) {
								ws.close();
							}
						},
						on: ( event, callback ) => {
							if ( event === 'status' ) {
								statusCallbacks.push( callback );
								if ( connected ) {
									callback( { status: 'connected' } );
								}
							}
						},
					};
				},
			];
		}
	);
}

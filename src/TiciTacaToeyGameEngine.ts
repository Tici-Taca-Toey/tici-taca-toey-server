import {
  GameEngine,
  MessageTypes,
  GameStatus,
  Message,
  ErrorCodes,
  ConnectedPlayer,
  Game,
  Response,
  GameStore,
  COMPLETED_GAME_STATUS,
  CalculateWinnerInputType,
  CalculateWinnerOutputType,
} from "./model";
import WebSocket = require("ws");

const uniq = require("lodash.uniq");

const EMPTY_POSITION = "-";

class TiciTacaToeyGameEngine implements GameEngine {
  games;
  players;
  robots;

  constructor() {
    this.games = {};
    this.players = {};
    this.robots = {};
  }

  play(message: Message, notify: boolean = true) {
    return new Promise<GameEngine>((resolve, reject) => {
      this.validate(message)
        .then((message) => {
          this.transition(message);
          if (notify) {
            this.notify(message);
          }
          resolve(this);
        })
        .catch((error) => {
          if (notify) {
            this.notifyError.bind(this)(error);
          }
        });
    });
  }

  // todo: unify the multiple switch cases below
  validate(message: Message) {
    return new Promise<Message>((resolve, reject) => {
      switch (message.type) {
        case MessageTypes.REGISTER_PLAYER:
          break;
        case MessageTypes.REGISTER_ROBOT:
          break;
        case MessageTypes.PLAYER_DISCONNECT:
          break;
        case MessageTypes.START_GAME: {
          if (parseInt("" + message.boardSize) < 2) {
            reject({ error: ErrorCodes.BOARD_SIZE_LESS_THAN_2, message });
          }
          if (parseInt("" + message.playerCount) < 2) {
            reject({ error: ErrorCodes.PLAYER_COUNT_LESS_THAN_2, message });
          }
          if (
            parseInt("" + message.playerCount) >=
            parseInt("" + message.boardSize)
          ) {
            reject({
              error: ErrorCodes.PLAYER_COUNT_MUST_BE_LESS_THAN_BOARD_SIZE,
              message,
            });
          }
          if (parseInt("" + message.boardSize) > 12) {
            reject({
              error: ErrorCodes.BOARD_SIZE_CANNOT_BE_GREATER_THAN_12,
              message,
            });
          }
          if (parseInt("" + message.playerCount) > 10) {
            reject({
              error: ErrorCodes.PLAYER_COUNT_CANNOT_BE_GREATER_THAN_10,
              message,
            });
          }
          if (
            parseInt("" + message.boardSize) < parseInt("" + message.winningSequenceLength)
          ) {
            reject({
              error: ErrorCodes.WIN_SEQ_LENGTH_MUST_BE_LESS_THAN_OR_EQUAL_TO_BOARD_SIZE,
              message,
            });
          }
          break;
        }
        case MessageTypes.SPECTATE_GAME: {
          if (
            !this.games[message.gameId] ||
            ![
              GameStatus.GAME_IN_PROGRESS,
              GameStatus.WAITING_FOR_PLAYERS,
            ].includes(this.games[message.gameId].status)
          ) {
            reject({ error: ErrorCodes.GAME_NOT_FOUND, message });
          }
          if (this.games[message.gameId].players.includes(message.playerId)) {
            reject({ error: ErrorCodes.PLAYER_ALREADY_PART_OF_GAME, message });
          }
          if (this.games[message.gameId].spectators.length >= 15) {
            reject({
              error: ErrorCodes.SPECTATOR_COUNT_CANNOT_BE_GREATER_THAN_10,
              message,
            });
          }
          break;
        }
        case MessageTypes.JOIN_GAME: {
          if (!this.games[message.gameId]) {
            reject({ error: ErrorCodes.GAME_NOT_FOUND, message });
          }
          if (this.games[message.gameId].players.includes(message.playerId)) {
            reject({ error: ErrorCodes.PLAYER_ALREADY_PART_OF_GAME, message });
          }
          if (
            this.games[message.gameId].status !== GameStatus.WAITING_FOR_PLAYERS
          ) {
            reject({ error: ErrorCodes.GAME_ALREADY_IN_PROGRESS, message });
          }
          break;
        }
        case MessageTypes.MAKE_MOVE: {
          if (
            this.games[message.gameId].status !== GameStatus.GAME_IN_PROGRESS
          ) {
            reject({ error: ErrorCodes.GAME_NOT_FOUND, message });
          }
          if (this.games[message.gameId].turn !== message.playerId) {
            reject({ error: ErrorCodes.MOVE_OUT_OF_TURN, message });
          }
          if (
            this.games[message.gameId].positions[message.coordinateX][
              message.coordinateY
            ] !== EMPTY_POSITION
          ) {
            reject({ error: ErrorCodes.INVALID_MOVE, message });
          }
          break;
        }
        default:
          reject({ error: ErrorCodes.BAD_REQUEST, message });
      }
      resolve(message);
    });
  }

  transition(message: Message) {
    switch (message.type) {
      case MessageTypes.REGISTER_PLAYER: {
        this.players = addPlayer(this.players, message.playerId, message.name, message.connection);
        break;
      }      
      case MessageTypes.REGISTER_ROBOT: {
        const { type, ...robotData } = message;
        this.robots = {
          ...this.robots,
          [message.playerId]: { ...robotData },
        };
        break;
      }
      case MessageTypes.PLAYER_DISCONNECT: {
        // Remove player from players list
        const { playerId } = message;
        const { [playerId]: omit, ...rest } = this.players;
        this.players = rest;
        // Transition games to GAME_ABANDONED state
        this.games = Object.values(this.games).reduce(
          (acc: GameStore, each: Game): GameStore => {
            if (
              each.players.includes(playerId) &&
              !COMPLETED_GAME_STATUS.includes(each.status)
            ) {
              acc[each.gameId] = {
                ...each,
                status: GameStatus.GAME_ABANDONED,
              };
            } else {
              acc[each.gameId] = each;
            }
            return acc;
          },
          {}
        );
        break;
      }
      case MessageTypes.START_GAME: {
        if (!(message.playerId in this.players)){
          this.players = addPlayer(this.players, message.playerId, "", message.connection);
        }
        const game = {
          gameId: message.gameId,
          name: message.name,
          boardSize: parseInt("" + message.boardSize),
          positions: generateBoard(message.boardSize),
          playerCount: message.playerCount
            ? parseInt("" + message.playerCount)
            : 2,
          winningSequenceLength: message.winningSequenceLength
          ? parseInt("" + message.winningSequenceLength)
          : parseInt("" + message.boardSize),
          players: [message.playerId],
          spectators: [],
          status: GameStatus.WAITING_FOR_PLAYERS,
        };
        this.games = {
          ...this.games,
          [message.gameId]: game,
        };
        break;
      }
      case MessageTypes.JOIN_GAME: {
        if (!(message.playerId in this.players)){
          this.players = addPlayer(this.players, message.playerId, "", message.connection);
        }

        const gameId = message.gameId;

        const updatedPlayersList = uniq([
          ...this.games[gameId].players,
          message.playerId,
        ]);

        const gameReadyToStart =
          updatedPlayersList.length === this.games[gameId].playerCount;

        const game = {
          ...this.games[gameId],
          players: [...updatedPlayersList],
          status: gameReadyToStart
            ? GameStatus.GAME_IN_PROGRESS
            : GameStatus.WAITING_FOR_PLAYERS,
          turn: gameReadyToStart ? this.games[gameId].players[0] : undefined,
        };
        this.games = {
          ...this.games,
          [message.gameId]: game,
        };
        break;
      }
      case MessageTypes.SPECTATE_GAME: {
        const updatedSpectatorsList = uniq([
          ...this.games[message.gameId].spectators,
          message.playerId,
        ]);

        this.games = {
          ...this.games,
          [message.gameId]: {
            ...this.games[message.gameId],
            spectators: [...updatedSpectatorsList],
          },
        };
        break;
      }
      case MessageTypes.MAKE_MOVE: {
        const game = this.games[message.gameId];
        const positions = [...this.games[game.gameId].positions];
        positions[message.coordinateX][message.coordinateY] = message.playerId;
        this.games = {
          ...this.games,
          [game.gameId]: {
            ...game,
            positions,
            turn: calculateNextTurn(game.players, game.turn, game.playerCount),
          },
        };

        const winner = calculateWinnerV2(
          {
            positions: game.positions,
            winningSequenceLength: game.winningSequenceLength,
            lastTurnPlayerId: message.playerId,
            lastTurnPosition: { x : message.coordinateX, y : message.coordinateY }
          });
        const tie = checkForDraw(this.games[message.gameId]);

        if (winner) {
          this.games = {
            ...this.games,
            [message.gameId]: {
              ...this.games[message.gameId],
              status: GameStatus.GAME_WON,
              winner: winner.winner,
              turn: "",
              winningSequence: winner.winningSquence,
            },
          };
        } else if (tie) {
          this.games = {
            ...this.games,
            [message.gameId]: {
              ...this.games[message.gameId],
              turn: "",
              status: GameStatus.GAME_ENDS_IN_A_DRAW,
            },
          };
        }

        break;
      }
    }
  }

  disconnectPlayer(playerId: string) {}

  // functions with side effects - websocket send operation

  notify(message: Message) {
    switch (message.type) {
      case MessageTypes.REGISTER_PLAYER, MessageTypes.REGISTER_ROBOT:
        const response: Response = {
          type: message.type,
          name: message.name,
          playerId: message.playerId,
        };
        message.connection.send(JSON.stringify(response));
        break;
      case MessageTypes.PLAYER_DISCONNECT:
        Object.values(this.games)
          .filter((each: Game) => each.players.includes(message.playerId))
          .forEach((game: Game) => {
            const connectedPlayers: ConnectedPlayer[] = Object.keys(
              this.players
            )
              .filter((each) => game.players.includes(each))
              .map((each) => this.players[each]);
            const connectedSpectators: ConnectedPlayer[] = Object.keys(
              this.players
            )
              .filter((each) => game.spectators.includes(each))
              .map((each) => this.players[each]);
            const response: Response = {
              // todo: extract as generic method
              type: message.type,
              game,
              players: connectedPlayers
                .map((each) => ({ name: each.name, playerId: each.playerId }))
                .reduce((acc, each) => {
                  acc[each.playerId] = each;
                  return acc;
                }, {}),
              spectators: connectedSpectators
                .map((each) => ({ name: each.name, playerId: each.playerId }))
                .reduce((acc, each) => {
                  acc[each.playerId] = each;
                  return acc;
                }, {}),
            };
            connectedPlayers.forEach((player) => {
              player.connection.send(JSON.stringify(response));
            });
            connectedSpectators.forEach((player) => {
              player.connection.send(
                JSON.stringify({
                  ...response,
                  type: MessageTypes.SPECTATE_GAME,
                })
              );
            });
          });
        break;
      case MessageTypes.START_GAME:
      case MessageTypes.JOIN_GAME:
      case MessageTypes.SPECTATE_GAME:
      case MessageTypes.MAKE_MOVE: {
        const game = this.games[message.gameId];
        const connectedPlayers: ConnectedPlayer[] = Object.keys(this.players)
          .filter((each) => game.players.includes(each))
          .map((each) => this.players[each]);
        const connectedSpectators: ConnectedPlayer[] = Object.keys(this.players)
          .filter((each) => game.spectators.includes(each))
          .map((each) => this.players[each]);
        const response: Response = {
          type: [GameStatus.GAME_WON, GameStatus.GAME_ENDS_IN_A_DRAW].includes(
            game.status
          )
            ? MessageTypes.GAME_COMPLETE
            : message.type,
          game,
          players: connectedPlayers
            .map((each) => ({ name: each.name, playerId: each.playerId }))
            .reduce((acc, each) => {
              acc[each.playerId] = each;
              return acc;
            }, {}),
          spectators: connectedSpectators
            .map((each) => ({ name: each.name, playerId: each.playerId }))
            .reduce((acc, each) => {
              acc[each.playerId] = each;
              return acc;
            }, {}),
        };
        connectedPlayers.forEach((player) => {
          player.connection.send(JSON.stringify(response));
        });
        connectedSpectators.forEach((player) => {
          player.connection.send(
            JSON.stringify({ ...response, type: MessageTypes.SPECTATE_GAME })
          );
        });
        break;
      }
      default:
        break;
    }
  }

  notifyError(error) {
    const player: ConnectedPlayer = this.players[error.message.playerId];
    const { ["connection"]: omit, ...message } = error.message;
    player.connection.send(
      JSON.stringify({ ...error, message, type: "ERROR" })
    );
  }
}

const addPlayer = (
  players: {
    [key: string]: ConnectedPlayer;
  },
  playerId: string,
  name: string,
  connection: WebSocket
  ): any => {
  return {
    ...players,
    [playerId]: { "playerId": playerId, "name": name, "connection": connection },
  };
}

const calculateNextTurn = (
  players: string[],
  currentTurn: string,
  playerCount: number
): string => {
  const nextPlayerIndex = (players.indexOf(currentTurn) + 1) % playerCount;
  return players[nextPlayerIndex];
};

const generateBoard = (boardSize: number): string[][] => {
  // todo: refactor
  const arr = [];
  for (let i = 0; i < boardSize; i++) {
    const innerArr = [];
    for (let j = 0; j < boardSize; j++) {
      innerArr.push(EMPTY_POSITION);
    }
    arr.push(innerArr);
  }
  return arr;
};

const checkForDraw = (game: Game): boolean => {
  for (let i = 0; i < game.boardSize; i++) {
    for (let j = 0; j < game.boardSize; j++) {
      if (game.positions[i][j] === "-") {
        return false;
      }
    }
  }
  return true;
};

// todo: refactor
const calculateWinner = (
  game: Game
): { playerId: string; sequence: string } => {
  // check all rows
  for (let i = 0; i < game.boardSize; i++) {
    const row: string[] = uniq(game.positions[i]);
    if (row.includes("-")) {
      continue;
    }
    if (row.length === 1) {
      return {
        playerId: row[0], // winning player
        sequence: `row-${i}`,
      };
    }
  }
  // check all cols
  for (let i = 0; i < game.boardSize; i++) {
    const column = [];
    for (let j = 0; j < game.boardSize; j++) {
      column.push(game.positions[j][i]);
    }
    if (column.includes("-")) {
      continue;
    }
    const uniqueValuesInRow = uniq(column);
    if (uniqueValuesInRow.length === 1) {
      return {
        playerId: uniqueValuesInRow[0], // winning player
        sequence: `column-${i}`,
      };
    }
  }
  // check diagonals
  const diagonalLTR = [];
  const diagonalRTL = [];
  for (let i = 0; i < game.boardSize; i++) {
    diagonalLTR.push(game.positions[i][i]);
    diagonalRTL.push(game.positions[i][game.boardSize - 1 - i]);
  }
  if (!diagonalLTR.includes("-")) {
    const uniqueDiagonalLTR = uniq(diagonalLTR);
    if (uniqueDiagonalLTR.length === 1) {
      return {
        playerId: uniqueDiagonalLTR[0], // winning player
        sequence: `Diagonal LTR`,
      };
    }
  }
  if (!diagonalRTL.includes("-")) {
    const uniqueDiagonalRTL = uniq(diagonalRTL);
    if (uniqueDiagonalRTL.length === 1) {
      return {
        playerId: uniqueDiagonalRTL[0], // winning player
        sequence: `Diagonal RTL`,
      };
    }
  }
  return null;
};

export const calculateWinnerV2 = (
  input: CalculateWinnerInputType
): CalculateWinnerOutputType => {
  let start=0;
  let end=0;
  let count=0;
  let winningSquence=[];
  const size = input.positions.length;
  const seqLength = input.winningSequenceLength;
  const x = input.lastTurnPosition.x;
  const y = input.lastTurnPosition.y;

  //check horizontal
  start = y-(seqLength-1)<0?0:y-(seqLength-1);
  end = y+(seqLength-1)>size-1?size-1:y+(seqLength-1);
  for(let i=start;i<=end;i++) {
      if (!(input.lastTurnPlayerId === input.positions[x][i])) {
          count = 0;
          continue;
      } else {
          count++;
          winningSquence.push({x:x,y:i});
      }
      if (count === seqLength){
        return {
          winner: input.lastTurnPlayerId, // winning player
          winningSquence: winningSquence,
        };
      }
  }

  //check vertical
  count=0;
  winningSquence = [];
  start = x-(seqLength-1)<0?0:x-(seqLength-1);
  end = x+(seqLength-1)>size-1?size-1:x+(seqLength-1);
  for(let i=start;i<=end;i++) {
      if (!(input.lastTurnPlayerId === input.positions[i][y])) {
          count = 0;
          continue;
      } else {
          count++;
          winningSquence.push({x:i,y:y});
      }
      if (count == seqLength) {
        return {
          winner: input.lastTurnPlayerId, // winning player
          winningSquence: winningSquence,
        };
      }
  }

  //check right diagonal
  count=1;
  winningSquence = [{x:x,y:y}];
  let xPosLeft = x-1;
  let yPosLeft = y-1;
  while(xPosLeft>=0 && yPosLeft>=0) {
      if (!(input.lastTurnPlayerId === input.positions[xPosLeft][yPosLeft])) {
          break;
      }
      else{
          count++;
          winningSquence.push({x:xPosLeft,y:yPosLeft});
      }
      xPosLeft--; yPosLeft--;
      if (count == seqLength) {
        return {
          winner: input.lastTurnPlayerId, // winning player
          winningSquence: winningSquence,
        };
      }
  }
  let xPosRight = x+1;
  let yPosRight = y+1;
  while(xPosRight<size && yPosRight<size) {
    if (!(input.lastTurnPlayerId === input.positions[xPosRight][yPosRight])) {
        break;
    }
    else{
      count++;
      winningSquence.push({x:xPosRight,y:yPosRight});
    }
    xPosRight--; xPosRight--;
    if (count == seqLength) {
      return {
        winner: input.lastTurnPlayerId, // winning player
        winningSquence: winningSquence,
      };
    }
  }

  //check left diagonal
  count=1;
  winningSquence = [{x:x,y:y}];
  xPosLeft = x+1;xPosRight = x-1;
  yPosLeft = y-1;yPosRight = y+1;
  while(xPosLeft<size && yPosLeft>=0) {
    if (!(input.lastTurnPlayerId === input.positions[xPosLeft][yPosLeft])) {
      break;
    }
    else{
      count++;
      winningSquence.push({x:xPosLeft,y:yPosLeft});
    }
    xPosLeft++; yPosLeft--;
    if (count == seqLength) {
      return {
        winner: input.lastTurnPlayerId, // winning player
        winningSquence: winningSquence,
      };
    }
  }
  while(xPosRight>=0 && yPosRight<size) {
    if (!(input.lastTurnPlayerId === input.positions[xPosRight][yPosRight])) {
      break;
    }
    else{
      count++;
      winningSquence.push({x:xPosRight,y:yPosRight});
    }
    xPosRight--; yPosRight++;
    if (count == seqLength) {
      return {
        winner: input.lastTurnPlayerId, // winning player
        winningSquence: winningSquence,
      };
    }
  }
  return null;
};

export default TiciTacaToeyGameEngine;

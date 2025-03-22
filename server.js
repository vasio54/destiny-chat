const express = require('express');
const app = express();
const http = require('http').Server(app);
const io = require('socket.io')(http, {
  cors: { origin: '*' },
  pingTimeout: 60000,
  pingInterval: 25000
});

app.use(express.static(__dirname));

// 儲存等待中的使用者，key 是 userId
const waitingUsers = { male: [], female: [] };
const roomMessages = {};
const userRooms = new Map(); // 儲存 userId 與房間的映射
const userSockets = new Map(); // 儲存 userId 與 socket 的映射
let roomCounter = 0; // 用於生成獨立的房間 ID

io.on('connection', (socket) => {
  console.log('用戶已連線:', socket.id);

  // 當使用者連線時，檢查是否有 userId，若無則生成一個
  socket.on('setUserId', (userId) => {
    userSockets.set(userId, socket);
    socket.userId = userId; // 將 userId 綁定到 socket
    console.log(`用戶 ${socket.id} 設置 userId: ${userId}`);
  });

  socket.on('startMatching', (data) => {
    const { targetGender, userId } = data;
    console.log(`${socket.id} (userId: ${userId}) 請求配對，目標性別: ${targetGender}`);

    const oppositeTargetGender = targetGender === 'male' ? 'female' : 'male';

    // 移除 socket 從所有等待列表，避免重複
    for (const gender in waitingUsers) {
      const index = waitingUsers[gender].findIndex(user => user.userId === userId);
      if (index !== -1) {
        waitingUsers[gender].splice(index, 1);
        console.log(`${userId} 從 ${gender} 等待列表移除，避免重複`);
      }
    }

    const waitingList = waitingUsers[oppositeTargetGender];
    if (waitingList.length > 0) {
      const partner = waitingList.shift();
      const room = `room-${roomCounter++}`; // 使用獨立的房間 ID
      
      // 將房間與 userId 關聯
      userRooms.set(userId, room);
      userRooms.set(partner.userId, room);

      // 加入房間
      socket.join(room);
      const partnerSocket = userSockets.get(partner.userId);
      if (partnerSocket) {
        partnerSocket.join(room);
        io.to(socket.id).emit('matchSuccess', { room, userId });
        io.to(partnerSocket.id).emit('matchSuccess', { room, userId: partner.userId });
        console.log(`配對成功: ${userId} (目標: ${targetGender}) 和 ${partner.userId} (目標: ${oppositeTargetGender})，房間: ${room}`);
        roomMessages[room] = [];
      } else {
        console.log(`配對失敗：找不到 ${partner.userId} 的 socket`);
        socket.emit('error', 'Matching failed, please try again.');
      }
    } else {
      waitingUsers[targetGender].push({ userId, socket });
      socket.emit('waiting', 'Waiting for a match...');
      console.log(`${userId} (目標: ${targetGender}) 已加入 ${targetGender} 等待列表，當前長度: ${waitingUsers[targetGender].length}`);
    }
  });

  socket.on('joinRoom', ({ room, userId }) => {
    userSockets.set(userId, socket);
    socket.userId = userId;
    socket.join(room);
    userRooms.set(userId, room);
    console.log(`${userId} (socket: ${socket.id}) 加入房間: ${room}`);
    const clients = io.sockets.adapter.rooms.get(room);
    console.log(`房間 ${room} 當前成員: ${clients ? Array.from(clients) : '無成員'}`);

    if (roomMessages[room] && roomMessages[room].length > 0) {
      roomMessages[room].forEach((msg) => {
        socket.emit('message', msg);
      });
      console.log(`${userId} 收到緩衝訊息: ${roomMessages[room].length} 條`);
    }
  });

  socket.on('message', (msg) => {
    const room = Array.from(socket.rooms)[1];
    if (room) {
      const messageData = { user: socket.userId, text: msg };
      io.to(room).emit('message', messageData);
      if (!roomMessages[room]) roomMessages[room] = [];
      roomMessages[room].push(messageData);
      console.log(`房間 ${room} 訊息: ${msg}`);
    }
  });

  socket.on('typing', () => {
    const room = Array.from(socket.rooms)[1];
    if (room) {
      socket.to(room).emit('typing');
    }
  });

  socket.on('stopTyping', () => {
    const room = Array.from(socket.rooms)[1];
    if (room) {
      socket.to(room).emit('stopTyping');
    }
  });

  socket.on('leaveChat', () => {
    const room = Array.from(socket.rooms)[1];
    if (room) {
      const clients = io.sockets.adapter.rooms.get(room);
      if (clients) {
        clients.forEach((clientId) => {
          if (clientId !== socket.id) {
            io.to(clientId).emit('partnerLeft', 'The other person has left the chat');
            const partnerSocket = io.sockets.sockets.get(clientId);
            if (partnerSocket) {
              partnerSocket.leave(room);
              userRooms.delete(partnerSocket.userId);
              console.log(`${partnerSocket.userId} 被踢出房間 ${room}`);
            }
          }
        });
      }
      socket.leave(room);
      userRooms.delete(socket.userId);
      delete roomMessages[room];
      console.log(`${socket.userId} 離開聊天，房間 ${room} 已解散`);
    }
  });

  socket.on('disconnect', () => {
    for (const gender in waitingUsers) {
      const index = waitingUsers[gender].findIndex(user => user.userId === socket.userId);
      if (index !== -1) {
        waitingUsers[gender].splice(index, 1);
        console.log(`${socket.userId} 從 ${gender} 等待列表移除`);
      }
    }
    userSockets.delete(socket.userId);
    const room = Array.from(socket.rooms)[1];
    if (room) {
      console.log(`${socket.userId} 斷線，但保留房間 ${room} 狀態`);
    }
    console.log(`${socket.id} 已斷線`);
  });
});

http.listen(process.env.PORT || 3000, () => {
  console.log('伺服器運行於端口', process.env.PORT || 3000);
});
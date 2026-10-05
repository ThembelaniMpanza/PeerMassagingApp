import 'package:path/path.dart' as p;
import 'package:peer_messaging_app/messaging/message_model.dart';
import 'package:sqflite/sqflite.dart';

class AppDatabase {
  static Database? _database;

  static Future<Database> get database async {
    if (_database != null) {
      return _database!;
    }

    final databasePath = await getDatabasesPath();
    final path = p.join(databasePath, 'peer_messages.db');

    _database = await openDatabase(
      path,
      version: 1,
      onCreate: _createTables,
    );

    return _database!;
  }

  static Future<void> init() async {
    await database;
  }

  static Future<void> _createTables(Database db, int version) async {
    await db.execute('''
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        senderId TEXT NOT NULL,
        senderName TEXT NOT NULL,
        text TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        type TEXT NOT NULL
      )
    ''');
  }

  static Future<void> insertMessage(MessageModel message) async {
    final db = await database;
    await db.insert(
      'messages',
      message.toJson(),
      conflictAlgorithm: ConflictAlgorithm.replace,
    );
  }

  static Future<List<MessageModel>> messagesFor(String contactId) async {
    final db = await database;
    final rows = await db.query(
      'messages',
      where: 'senderId = ?',
      whereArgs: [contactId],
      orderBy: 'timestamp ASC',
    );

    return rows.map(MessageModel.fromJson).toList();
  }
}

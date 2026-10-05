import 'package:flutter/material.dart';
import 'package:peer_messaging_app/app.dart';
import 'package:peer_messaging_app/storage/database.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  databaseFactory = databaseFactoryFfi;
  await AppDatabase.init();
  runApp(const PeerMessagingApp());
}
